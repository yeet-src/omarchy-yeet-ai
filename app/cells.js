/* A cell is one `:::chart` block, running.
 *
 * The block's body is compiled once and run in the isolate with a small
 * scope: `subscribe` over the system graph, `plot` to hand a reading to
 * the chart, `rate` for counters, `graph` for a one-shot lookup. What
 * the body plots accumulates here as series — or, for a ranking, as the
 * latest set of bars — and every change is reported through `notify`
 * so the page can redraw exactly that chart.
 *
 * Model code runs on the host. It is confined to the isolate and to
 * this scope, with a timeout on the body itself, but it is not
 * sandboxed beyond that: the panel keeps a `src` toggle for a reason.
 *
 * Nothing here may leak an unhandled rejection — the host answers one
 * by killing the isolate, which would take every chart with it — so
 * each callback the body registers is contained.
 */

const HIST = 400; /* samples kept per series — more than the panel can show */
const EVAL_TIMEOUT_MS = 10_000;
const MIN_LIVE_MS = 250;
const MAX_BARS = 24;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/* A body is either an expression or statements ending in a return.
 * Compiling as an expression first and falling back asks the parser
 * instead of pattern-matching the source. The body runs one scope down
 * from the parameters that carry the context, so a body that declares
 * `const state = …` shadows rather than clashes. */
export const compile = (names, source) => {
  const body = String(source ?? "").trim();
  try {
    return new AsyncFunction(...names, `return await (async () => (\n${body}\n))();`);
  } catch {
    return new AsyncFunction(...names, `return await (async () => {\n${body}\n})();`);
  }
};

const push = (values, value) => {
  values.push(value);
  if (values.length > HIST) values.splice(0, values.length - HIST);
};

export function createCell(block, { graph, notify = () => {}, now = Date.now }) {
  const view = {
    series: {}, /* name -> number[] */
    order: [], /* series names, in the order first plotted */
    bars: null, /* [{ label, value }] for a ranking */
    latest: {}, /* name -> last value */
    samples: 0,
    error: null,
    fails: 0,
    subscribed: false,
    firstAt: null,
  };

  const tickets = [];
  const cleanups = [];
  const timers = new Set();
  const counters = new Map();
  const state = {};
  let released = false;
  let liveTimer = null;

  const changed = () => {
    try {
      notify(view);
    } catch (error) {
      console.warn(`askai: notify threw: ${error?.message ?? error}`);
    }
  };

  const fail = (error) => {
    if (released) return;
    view.error = String(error?.message ?? error);
    view.fails += 1;
    changed();
  };

  /* A body's callbacks fire outside every try the evaluator holds, so
   * a throw or a rejection there is contained here. */
  const contained = (fn) => (...args) => {
    if (released) return;
    try {
      const out = fn(...args);
      if (typeof out?.then === "function") out.then(null, fail);
    } catch (error) {
      fail(error);
    }
  };

  /* `plot(rate(...))` on the first sample is `plot(null)`: nothing to
   * draw yet, not a zero. */
  const plot = (value) => {
    if (released || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      view.bars = value.slice(0, MAX_BARS).map((row) =>
        row && typeof row === "object"
          ? { label: String(row.label ?? row.name ?? ""), value: Number(row.value) }
          : { label: String(row), value: NaN },
      );
    } else if (value !== null && typeof value === "object") {
      for (const [name, raw] of Object.entries(value)) {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        if (!view.series[name]) {
          view.series[name] = [];
          view.order.push(name);
        }
        push(view.series[name], n);
        view.latest[name] = n;
      }
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      if (!view.series.value) {
        view.series.value = [];
        view.order.push("value");
      }
      push(view.series.value, n);
      view.latest.value = n;
    }
    view.samples += 1;
    view.firstAt ??= now();
    changed();
  };

  /* Per-second change of a cumulative counter, keyed so a body can
   * track several. Null on the first call, when there is nothing to
   * subtract from; measured against wall time rather than the interval
   * asked for, because the two differ. */
  const rate = (key, value) => {
    const n = Number(value);
    const at = now();
    const before = counters.get(key);
    counters.set(key, { value: n, at });
    if (!before || !Number.isFinite(n) || at <= before.at) return null;
    return ((n - before.value) * 1000) / (at - before.at);
  };

  const subscribe = (source, callback, onError) => {
    if (released) return Promise.resolve(null);
    view.subscribed = true;
    const deliver = contained((sample) => {
      if (sample && sample.__error !== undefined) {
        onError?.(sample.__error);
        throw new Error(`subscription: ${sample.__error}`);
      }
      callback?.(sample?.data ?? sample);
    });
    const ticket = Promise.resolve()
      .then(() => graph.subscribe(String(source), deliver))
      .then((t) => {
        if (released) graph.unsubscribe(t);
        else tickets.push(t);
        return t;
      });
    ticket.catch((error) => {
      onError?.(error);
      fail(error);
    });
    return ticket;
  };

  const query = async (source) => {
    const response = await graph.query(String(source));
    if (response?.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
    return response?.data ?? response;
  };

  const timer = (set, clear) => (fn, ms, ...rest) => {
    const id = set(contained(fn), ms, ...rest);
    timers.add({ id, clear });
    return id;
  };

  const scope = {
    subscribe,
    plot,
    rate,
    graph: query,
    state,
    onCleanup: (fn) => {
      if (typeof fn === "function") cleanups.push(fn);
    },
    log: (...args) => console.log(`[chart ${block.label || "?"}]`, ...args.map(String)),
    setTimeout: timer(setTimeout, clearTimeout),
    setInterval: timer(setInterval, clearInterval),
    clearTimeout,
    clearInterval,
  };

  const live = Number(block.attrs?.live);

  /* One evaluation of the body. A returned value is plotted, which is
   * the polling shape: with `live=` the body re-runs on that interval. */
  const evaluate = async () => {
    if (released) return;
    let fn;
    try {
      fn = compile(Object.keys(scope), block.script);
    } catch (error) {
      fail(new Error(`syntax: ${error.message}`));
      return;
    }
    let timeout;
    try {
      const out = await Promise.race([
        fn(...Object.values(scope)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`body took longer than ${EVAL_TIMEOUT_MS / 1000}s`)), EVAL_TIMEOUT_MS);
        }),
      ]);
      if (out !== undefined && out !== null) plot(out);
    } catch (error) {
      fail(error);
    } finally {
      clearTimeout(timeout);
    }
    if (!released && Number.isFinite(live) && live > 0 && !view.subscribed) {
      liveTimer = setTimeout(() => {
        liveTimer = null;
        evaluate().catch(fail);
      }, Math.max(MIN_LIVE_MS, live));
    }
  };

  const release = () => {
    if (released) return;
    released = true;
    if (liveTimer) clearTimeout(liveTimer);
    for (const { id, clear } of timers) clear(id);
    timers.clear();
    for (const t of tickets) {
      try {
        Promise.resolve(graph.unsubscribe(t)).catch(() => {});
      } catch {
        /* gone already */
      }
    }
    tickets.length = 0;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (error) {
        console.warn(`askai: cleanup threw: ${error?.message ?? error}`);
      }
    }
  };

  return {
    block,
    view,
    run: () => evaluate().catch(fail),
    release,
    get released() {
      return released;
    },
  };
}
