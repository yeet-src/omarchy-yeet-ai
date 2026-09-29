import { Index, Show, createSignal, onCleanup } from "yeetkit";
import { runTool, stream } from "yeet:ai";

import { createAgent } from "./agent.js";
import { createCell } from "./cells.js";
import { keyOf, parse } from "./directive.js";
import { axis, bars, braille, chart, clip, fmt, line, rowHeat, stackedTotals } from "./draw.js";
import { SYSTEM, context, repair, withSchema } from "./prompt.js";
import { loadSchema } from "./schema.js";
import { createTools } from "./tools.js";

/* The whole plugin is one page. <bar> is the item in the bar — `yeet:ai`,
 * with the newest chart's sparkline beside it — and <panel> is what
 * opens under it: an input, and under it every question asked, newest
 * first, each holding the prose the model wrote and the charts it
 * drew.
 *
 * The model does not describe a reading; it writes the instrument that
 * takes it. Its reply carries `:::chart` blocks — the shape the
 * notebook's `:::ui` has — whose bodies run here, in the isolate, next
 * to the system graph. A body subscribes over `yeet.graph.subscribe`
 * and plots what arrives; the panel draws the series as braille on the
 * same character grid proctop uses. Nothing polls: the daemon pushes
 * each sample at the interval the block asked for.
 *
 * No colour is named here: `heat` takes one from the theme, so the
 * panel follows whatever theme is running. */

/* The models the pull-down offers. The platform adapts one request
 * shape to whichever provider serves the name. */
const MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
  "gpt-5",
  "gpt-5-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];
const DEFAULT_MODEL = MODELS[0];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_W = 4; /* braille cells for the bar item's sparkline: 8 samples */
const DEFAULT_ROWS = 4;
const REPAIR_WAIT = 4000; /* a chart that has not drawn or failed by then is left alone */
const MAX_REPAIRS = 2;
const LABELS = { graph_schema: "reading schema", graph_query: "querying" };

const HINT =
  "Ask for a chart of this host: “cpu”, “top processes by memory”, "
  + "“network throughput”, “disk reads and writes”. The model writes a "
  + "subscription over the system graph and the panel draws what arrives.";

const graph = {
  query: (q) => yeet.graph.query(q),
  subscribe: (q, cb) => yeet.graph.subscribe(q, cb),
  unsubscribe: (t) => yeet.graph.unsubscribe(t),
};

const num = (v) => (v === undefined || v === null || v === true ? NaN : Number(v));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isChart = (seg) => seg.kind === "block" && seg.name === "chart";
/* A header line shares its row with a small button, so it is padded to
 * the grid less the button's room. Rows are laid out by hand rather
 * than with `fill`: a text alone filling a row has no height until the
 * row is laid out, and the panel measures before that. */
const BUTTON_COLS = 6;

export default function Page() {
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [usage, setUsage] = createSignal(null);
  const [cards, setCards] = createSignal([]);
  const [cols, setCols] = createSignal(48);
  const [open, setOpen] = createSignal(false);
  const [model, setModel] = createSignal(DEFAULT_MODEL);
  const [picking, setPicking] = createSignal(false);
  /* The graph's schema, introspected once and carried in every prompt.
   * Until it is in, the status line says so and a question waits. */
  const [schema, setSchema] = createSignal(null);
  const [tick, setTick] = createSignal(0);
  /* Bumped when a cell is added or released, so a lookup in the map
   * below re-runs. The map itself is plain: it is mutated in place. */
  const [generation, setGeneration] = createSignal(0);
  const [sources, setSources] = createSignal({});

  /* `${cardId}/${blockKey}` -> { cell, view } — every chart running. A
   * block's identity is its code (see directive.js), so re-parsing the
   * reply as it streams finds the same cell rather than restarting it. */
  const cells = new Map();
  /* Cards with a repair pending, so a chart failing every tick asks once. */
  const armed = new Set();
  let nextId = 1;

  const { tools } = createTools(graph.query);
  const agent = createAgent({
    model: () => model(),
    system: () => (schema() ? withSchema(schema().sdl) : SYSTEM),
    tools,
    stream,
    runTool,
    on: { usage: setUsage },
  });

  const schemaLoad = loadSchema(graph.query).then(
    (loaded) => {
      /* stderr: the isolate's stdout is the wire to the shell, and only
       * stderr reaches the shell log. */
      console.warn(`askai: schema ${loaded.types} types, ${loaded.bytes} bytes`);
      setSchema(loaded);
    },
    (error) => console.warn(`askai: schema introspection failed, prompting without it: ${error?.message ?? error}`),
  );

  /* The spinner is the only clock here, so it runs only while a turn
   * is in flight. */
  const spinner = setInterval(() => {
    if (busy()) setTick((n) => n + 1);
  }, 100);

  onCleanup(() => {
    clearInterval(spinner);
    for (const entry of cells.values()) entry.cell.release();
    cells.clear();
    agent.cancel().catch(() => {});
  });

  const patch = (id, fn) => setCards((all) => all.map((card) => (card.id === id ? fn(card) : card)));
  const cellKey = (cardId, block) => `${cardId}/${keyOf(block)}`;
  const entryOf = (cardId, block) => {
    generation();
    return cells.get(cellKey(cardId, block)) ?? null;
  };

  /* Every closed chart block in a card's text has a cell; a block seen
   * for the first time starts one. Called on each streamed delta, so a
   * chart comes alive the moment its `::` lands, while the reply may
   * still be writing the next one. */
  const sync = (cardId, text) => {
    let added = false;
    for (const seg of parse(text)) {
      if (!isChart(seg) || seg.open) continue;
      const key = cellKey(cardId, seg);
      if (cells.has(key)) continue;
      const [view, setView] = createSignal(null);
      const cell = createCell(seg, {
        graph,
        notify: (v) => {
          setView({ ...v });
          /* A chart that starts failing after it drew — a field that is
           * null only sometimes — is worth a repair too, not only one
           * that never drew. */
          if (v.error && !armed.has(cardId)) {
            armed.add(cardId);
            doctor(cardId).catch(() => {}).finally(() => armed.delete(cardId));
          }
        },
      });
      cells.set(key, { cell, view });
      setView({ ...cell.view });
      cell.run();
      added = true;
    }
    if (added) setGeneration((n) => n + 1);
  };

  const releaseCard = (cardId) => {
    for (const [key, entry] of cells) {
      if (key.startsWith(`${cardId}/`)) {
        entry.cell.release();
        cells.delete(key);
      }
    }
    setGeneration((n) => n + 1);
  };

  const remove = (cardId) => {
    releaseCard(cardId);
    setCards((all) => all.filter((card) => card.id !== cardId));
  };

  const label = (call) => LABELS[call.name] ?? call.name;

  /* The loop closes: a chart's code runs after the reply is finished,
   * so the model cannot see its own instrument fail. A block that
   * threw — a guessed field, a bad selection — goes back to it with
   * the error, and the rewrite is substituted into the reply in place,
   * so what stands in the panel is the version that works. Bounded per
   * card, and only for a chart that never drew anything. */
  const doctor = async (id) => {
    await wait(REPAIR_WAIT);
    const card = cards().find((c) => c.id === id);
    if (!card || card.repairs >= MAX_REPAIRS || busy()) return;

    const broken = parse(card.text)
      .filter((seg) => isChart(seg) && !seg.open)
      .map((seg) => ({ seg, entry: cells.get(cellKey(id, seg)) }))
      .find(({ entry }) => {
        const v = entry?.view();
        return v?.error && (v.samples === 0 || v.fails >= 3);
      });
    if (!broken) return;

    const { seg, entry } = broken;
    setBusy(true);
    setStatus(`repairing ${seg.label || "chart"}`);
    patch(id, (c) => ({ ...c, repairs: c.repairs + 1 }));

    const outcome = await agent.ask(repair({ ...seg, source: card.text.slice(seg.start, seg.end) }, entry.view().error), {
      context: context(cols()),
      remember: false,
      on: {
        text: () => setStatus(`repairing ${seg.label || "chart"}`),
        tool: (call) => setStatus(label(call)),
        error: (message) => patch(id, (c) => ({ ...c, error: message })),
      },
    });
    setBusy(false);
    setStatus("");

    const fixed = parse(outcome.text).find((s) => isChart(s) && !s.open);
    const latest = cards().find((c) => c.id === id);
    if (!fixed || !latest) return;

    entry.cell.release();
    cells.delete(cellKey(id, seg));
    const text = latest.text.slice(0, seg.start) + outcome.text.slice(fixed.start, fixed.end) + latest.text.slice(seg.end);
    sync(id, text);
    patch(id, (c) => ({ ...c, text }));
    await doctor(id);
  };

  const submit = async () => {
    const question = draft().trim();
    if (!question || busy()) return;
    setDraft("");

    const id = nextId++;
    setCards((all) => [{ id, question, text: "", error: null, repairs: 0, done: false, cancelled: false }, ...all]);
    setBusy(true);
    setStatus(schema() ? "thinking" : "reading schema");

    try {
      await schemaLoad;
      const outcome = await agent.ask(question, {
        context: context(cols()),
        on: {
          text: (_delta, whole) => {
            sync(id, whole);
            patch(id, (c) => ({ ...c, text: whole }));
            setStatus("writing");
          },
          tool: (call) => setStatus(label(call)),
          toolResult: () => setStatus("thinking"),
          error: (message) => patch(id, (c) => ({ ...c, error: message })),
        },
      });
      sync(id, outcome.text);
      patch(id, (c) => ({
        ...c,
        text: outcome.text,
        done: true,
        error: outcome.error ?? c.error,
        cancelled: outcome.cancelled,
      }));
      setBusy(false);
      setStatus("");
      if (!outcome.error && !outcome.cancelled) doctor(id).catch((error) => console.warn(`askai: repair failed: ${error?.message ?? error}`));
    } catch (error) {
      patch(id, (c) => ({ ...c, done: true, error: String(error?.message ?? error) }));
      setBusy(false);
      setStatus("");
    }
  };

  const spin = () => SPINNER[tick() % SPINNER.length];

  /* The newest chart with a time series in it, for the bar item. */
  const newest = () => {
    for (const card of cards()) {
      for (const seg of parse(card.text)) {
        if (!isChart(seg)) continue;
        const view = entryOf(card.id, seg)?.view();
        if (view && view.order.length) return { view, seg };
      }
    }
    return null;
  };

  const barText = () => {
    const head = busy() ? `yeet:ai ${spin()}` : "yeet:ai";
    const top = newest();
    if (!top) return head;
    const name = top.view.order[0];
    const recent = top.view.series[name].slice(-BAR_W * 2);
    const band = axis(recent, num(top.seg.attrs.min), num(top.seg.attrs.max));
    return `${head} ${braille(recent, BAR_W, band.lo, band.hi, 1)[0]} ${fmt(top.view.latest[name], top.seg.attrs.unit)}`;
  };

  const chartCount = () => {
    let n = 0;
    for (const card of cards()) for (const seg of parse(card.text)) if (isChart(seg)) n += 1;
    return n;
  };

  const statusLine = () => {
    if (busy()) return `${spin()} ${status()}`;
    if (!schema()) return "reading schema…";
    const tokens = usage();
    const cost = tokens ? `${tokens.input_tokens}in/${tokens.output_tokens}out` : "";
    const charts = chartCount();
    /* `live` while the panel is open: the shell reports open and close,
     * and the charts keep sampling either way — the tag says someone is
     * looking. */
    return [cost, charts ? `${charts} chart${charts === 1 ? "" : "s"}` : "", open() ? "live" : ""]
      .filter(Boolean)
      .join(" · ");
  };

  const toggleSource = (key) => setSources((all) => ({ ...all, [key]: !all[key] }));

  /* One chart: header, the drawing, an axis line. `props.seg` is the
   * block's accessor from <Index>, so a re-parse patches the label and
   * the cell lookup follows the block's key. */
  const Chart = (props) => {
    const seg = () => props.seg();
    const key = () => cellKey(props.cardId, seg());
    const view = () => entryOf(props.cardId, seg())?.view() ?? null;
    const unit = () => seg().attrs.unit;
    const rows = () => clampInt(Number(seg().attrs.rows) || DEFAULT_ROWS, 1, 8);
    const width = () => cols();
    const windowOf = (name) => view().series[name].slice(-width() * 2);
    const single = () => view()?.order.length === 1;
    /* How the series share the graph: what the block said, else one
     * graph for one series and a graph each for several. */
    const kind = () => {
      const k = seg().attrs.kind;
      if (typeof k === "string" && k !== "bars") return k;
      return single() ? "area" : "split";
    };
    /* One axis for every series in the block, over the window on show —
     * for a stacked chart, over the totals it is drawn to. */
    const band = () => {
      const v = view();
      const windows = v.order.map(windowOf);
      const seen = kind() === "stacked" ? stackedTotals(windows) : windows.flat();
      return axis(seen, num(seg().attrs.min), num(seg().attrs.max));
    };
    const legend = () => {
      const v = view();
      return clip(v.order.map((name) => `${name} ${fmt(v.latest[name], unit())}`).join(" · "), width());
    };
    const footer = () => {
      const v = view();
      const b = band();
      return line(`${fmt(b.lo, unit())}–${fmt(b.hi, unit())}`, `${v.samples} samples`, width());
    };

    return (
      <column gap={0}>
        <row gap={4}>
          <Show
            when={view() && single() && !view().bars}
            fallback={<text bold>{clip(seg().label || "chart", width() - BUTTON_COLS)}</text>}
          >
            <text bold>{clip(seg().label || "chart", width() - BUTTON_COLS - 9)}</text>
            <text heat={0.6}>{fmt(view().latest[view().order[0]], unit()).padStart(8)}</text>
          </Show>
          <Show when={!seg().open}>
            <button
              horizontalPadding={4}
              verticalPadding={0}
              tooltipText={sources()[key()] ? "Hide the source" : "Show the source the model wrote"}
              onClick={() => toggleSource(key())}
            >
              src
            </button>
          </Show>
        </row>

        <Show when={seg().open}>
          <text size="caption" tone="muted">{`${spin()} writing…`}</text>
        </Show>
        <Show when={sources()[key()]}>
          <text size="caption" tone="muted" wrap fill>{seg().script}</text>
        </Show>

        <Show when={view()?.bars}>
          <Index each={bars(view().bars, width(), unit())}>{(l) => <text>{l()}</text>}</Index>
        </Show>

        <Show when={view() && !view().bars && view().order.length > 0}>
          <Show
            when={kind() === "split"}
            fallback={
              <column gap={0}>
                <Show when={!single()}>
                  <text size="caption" tone="muted">{legend()}</text>
                </Show>
                <Index each={chart(view().order.map(windowOf), width(), band().lo, band().hi, rows(), kind())}>
                  {(l, r) => <text heat={rowHeat(r, rows())}>{l()}</text>}
                </Index>
              </column>
            }
          >
            <Index each={view().order}>
              {(name) => (
                <column gap={0}>
                  <Show when={!single()}>
                    <text size="caption" tone="muted">{line(name(), fmt(view().latest[name()], unit()), width())}</text>
                  </Show>
                  <Index each={braille(windowOf(name()), width(), band().lo, band().hi, rows())}>
                    {(l, r) => <text heat={rowHeat(r, rows())}>{l()}</text>}
                  </Index>
                </column>
              )}
            </Index>
          </Show>
          <text size="caption" tone="muted">{footer()}</text>
        </Show>

        <Show when={view()?.error}>
          <text size="caption" tone="urgent" wrap fill>{view().error}</text>
        </Show>
        <Show when={view() && !view().samples && !view().error && !seg().open}>
          <text size="caption" tone="muted">waiting for data…</text>
        </Show>
      </column>
    );
  };

  return (
    <>
      <bar heat={busy() ? 0.5 : -1} tooltipText={`Ask AI — ${chartCount()} charts · ${model()}`}>
        {barText()}
      </bar>

      <panel
        contentWidth={420}
        gap={6}
        onCols={(e) => setCols(e.cols)}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
      >
        <input
          placeholder="Ask for a chart of this host…"
          value={draft()}
          onInput={(e) => setDraft(e.value)}
          onSubmit={(e) => {
            setDraft(e.value);
            submit().catch((error) => console.warn(`askai: ask failed: ${error?.message ?? error}`));
          }}
        />

        {/* The model is a pull-down: the button names the current one and
            opens a column of the rest under it; picking one closes it. */}
        <row gap={4}>
          <button
            horizontalPadding={4}
            verticalPadding={0}
            tooltipText="Choose the model"
            onClick={() => setPicking(!picking())}
          >
            {`${model()} ${picking() ? "▴" : "▾"}`}
          </button>
          <text size="caption" tone="muted">{statusLine()}</text>
          <Show when={busy()}>
            <button horizontalPadding={4} verticalPadding={0} tooltipText="Stop generating" onClick={() => agent.cancel()}>
              stop
            </button>
          </Show>
        </row>
        <Show when={picking()}>
          <column gap={0}>
            <Index each={MODELS}>
              {(name) => (
                <button
                  horizontalPadding={4}
                  verticalPadding={0}
                  selected={name() === model()}
                  onClick={() => {
                    setModel(name());
                    setPicking(false);
                  }}
                >
                  {name()}
                </button>
              )}
            </Index>
          </column>
        </Show>

        <Show when={!cards().length}>
          <text size="bodySmall" tone="muted" wrap fill>{HINT}</text>
        </Show>

        <Show when={cards().length > 0}>
            <scroll maxHeight={640} gap={6}>
            {/* <Index> keys by position and hands down an accessor, so a
                streamed delta patches the one card that changed. */}
            <Index each={cards()}>
              {(card, i) => (
                <column gap={2}>
                  <Show when={i > 0}>
                    <separator />
                </Show>
                <row gap={4}>
                  <text bold>{clip(`;; ${card().question}`, cols() - BUTTON_COLS)}</text>
                  <button horizontalPadding={4} verticalPadding={0} tooltipText="Remove this chart" onClick={() => remove(card().id)}>
                    ×
                  </button>
                </row>

                <Index each={parse(card().text)}>
                  {(seg) => (
                    <Show
                      when={isChart(seg())}
                      fallback={
                        <text size="bodySmall" wrap fill>
                          {seg().kind === "text" ? seg().text : seg().script}
                        </text>
                      }
                    >
                      <Chart seg={seg} cardId={card().id} />
                    </Show>
                  )}
                </Index>

                <Show when={!card().done && !card().text}>
                  <text size="caption" tone="muted">{`${spin()} ${status()}`}</text>
                </Show>
                <Show when={card().error}>
                  <text size="caption" tone="urgent" wrap fill>{card().error}</text>
                </Show>
                <Show when={card().cancelled}>
                  <text size="caption" tone="muted">— cancelled —</text>
                </Show>
              </column>
            )}
          </Index>
          </scroll>
        </Show>
      </panel>
    </>
  );
}
