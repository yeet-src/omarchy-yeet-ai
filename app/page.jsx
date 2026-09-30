import { Index, Show, createSignal, onCleanup } from "yeetkit";
import { runTool, stream } from "yeet:ai";

import { createAgent } from "./agent.js";
import { createCell } from "./cells.js";
import { keyOf, parse } from "./directive.js";
import { axis, braille, fmt } from "./draw.js";
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
  "gpt-5",
  "gpt-5-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];
const DEFAULT_MODEL = MODELS[0];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_W = 4; /* braille cells for the bar item's sparkline: 8 samples */
const WINDOW = 120; /* samples a chart is handed */
const CARD_W = 400; /* px, one card's chart */
const CARD_GAP = 12;
const CHART_H = 180;
const MAX_COLUMNS = 4;
const CLOSE_W = 32; /* px the × button takes beside a heading */
const CODE_H = 180; /* px of source shown before it scrolls */
const REPAIR_WAIT = 4000; /* a chart that has not drawn or failed by then is left alone */
const MAX_REPAIRS = 2;
const LABELS = { graph_schema: "reading schema", graph_query: "querying" };

/* Example questions, each checked to come back as a chart that draws.
 * Three are shown as bubbles, one of them as the placeholder, chosen
 * afresh each time the panel opens; Enter on the empty input asks the
 * placeholder. */
const EXAMPLES = [
  /* one reading over time — area, line */
  "how busy is the cpu?",
  "how much memory is in use?",
  "how many context switches per second?",
  "how many processes are running?",
  "how many interrupts per second?",
  "how much memory is available?",
  "how many sockets are open?",
  /* parts of a whole over time — stacked */
  "how is cpu time split between user and system?",
  "how is memory split: used, cached, free?",
  "how is cpu time split between busy and idle?",
  /* compared on one axis — overlay */
  "how much network traffic is there?",
  "how do packets in compare with packets out?",
  "how do the load averages compare?",
  /* different magnitudes — split */
  "how many processes and threads are running?",
  "what are the 1, 5 and 15 minute loads?",
  "how do tcp and udp socket counts compare?",
  /* one reading per thing over time — heat */
  "how busy is each cpu core?",
  "how much traffic is on each network interface?",
  /* one reading with a ceiling — gauge */
  "how full is the swap?",
  "what share of memory is in use?",
  "is the load average above the core count?",
  "how much of the cpu is idle right now?",
  /* a ranking — bars */
  "which processes use the most memory?",
  "which processes use the most cpu?",
  "which processes have the most threads?",
  "which processes have the most open files?",
  "which cpu core is the busiest right now?",
  /* parts of a whole now — pie */
  "how many tcp connections, by state?",
  "what share of memory do the top five hold?",
  "how are processes split by state?",
  /* two properties of many things — scatter */
  "memory against threads, per process?",
  "memory against open files, per process?",
];

/* Whole dashboards — several charts from one question. One of these is
 * always among the bubbles, so the grid is a suggestion too. */
const DASHBOARDS = [
  "show me a dashboard of this host",
  "give me a network dashboard",
  "give me a memory dashboard",
  "give me a process dashboard",
  "show me everything about the cpu",
  "give me a dashboard of the top processes",
  "show me a dashboard of the load on this host",
  "give me a dashboard of sockets and connections",
  "show me an overview of memory pressure",
  "give me a dashboard of what is busy right now",
  "give me a dashboard of disk activity",
  "show me a dashboard of the kernel: interrupts, context switches, run queue",
  "give me a dashboard of each cpu core",
  "show me a dashboard of network packets and errors",
  "give me a dashboard of the biggest processes",
  "show me a dashboard of memory: used, swap, cache, top consumers",
  "give me a dashboard of threads and processes",
  "show me a dashboard of listening ports and connections",
  "give me a dashboard of cpu pressure",
  "show me a dashboard of the last minute on this host",
  "give me a dashboard of the desktop: shell, compositor, audio",
  "show me a dashboard of what changed in the last five minutes",
  "give me a dashboard of the host at a glance",
  "show me a dashboard of tcp: states, queues, peers",
  "give me a dashboard of the load: 1, 5 and 15 minutes against the cores",
  "show me a dashboard of memory by kind over time",
  "give me a dashboard of the top talkers on the network",
  "show me a dashboard of process churn: starts, exits, states",
  "give me a dashboard of the file descriptors in use",
  "show me a dashboard of the cpu split by mode and by core",
  "give me a dashboard of the whole system in six charts",
];
const SHOWN = 1; /* single-chart bubbles on show at once… */
const DASH_SHOWN = 2; /* …beside this many dashboards: most suggestions are dashboards */
const ROTATE_MS = 10000; /* …and how often they move on */

const HINT = "Pick one, or type your own. The model writes a subscription over the system graph and the panel draws what arrives.";

/* Bubbles packed into rows by their width in pixels: the label at the
 * panel's measured character width, plus the button's padding and
 * border, plus the gap. */
const BUBBLE_PAD_PX = 18;
const BUBBLE_GAP_PX = 4;
const pack = (labels, widthPx, charPx) => {
  const rows = [];
  let row = [];
  let used = 0;
  for (const label of labels) {
    const w = label.length * charPx + BUBBLE_PAD_PX;
    if (w > widthPx) continue; /* would overflow even alone */
    if (row.length && used + BUBBLE_GAP_PX + w > widthPx) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(label);
    used += (row.length > 1 ? BUBBLE_GAP_PX : 0) + w;
  }
  if (row.length) rows.push(row);
  return rows;
};

/* A random order, so two panels do not start on the same question. */
const shuffle = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const graph = {
  query: (q) => yeet.graph.query(q),
  subscribe: (q, cb) => yeet.graph.subscribe(q, cb),
  unsubscribe: (t) => yeet.graph.unsubscribe(t),
};

const num = (v) => (v === undefined || v === null || v === true ? NaN : Number(v));
/* What the platform says when this host has no login: no token, or one
 * it rejects. Charts do not need one; asking does. */
const authError = (e) =>
  /WHOAMI_NOT_SET|WhoAmI is not set|access token|not logged in|logged out|unauthori[sz]ed|forbidden/i.test(
    `${e?.code ?? ""} ${e?.message ?? e ?? ""}`,
  );
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isChart = (seg) => seg.kind === "block" && seg.name === "chart";

export default function Page() {
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [usage, setUsage] = createSignal(null);
  const [cards, setCards] = createSignal([]);
  const [cols, setCols] = createSignal(48);
  /* The most the shell would give the panel on this screen, in pixels;
   * zero until it says. The grid stops growing before it is clipped. */
  const [availW, setAvailW] = createSignal(0);
  const [availH, setAvailH] = createSignal(0);
  /* The pixels the panel actually has: tiles are sized from it, so a
   * display scale or a clamp never leaves a tile overhanging. */
  const [panelW, setPanelW] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  const [model, setModel] = createSignal(DEFAULT_MODEL);
  const examples = shuffle(EXAMPLES);
  const dashboards = shuffle(DASHBOARDS);
  const [example, setExample] = createSignal(0);
  /* The three from the current one on: the next three each time the
   * panel opens, and every ten seconds while the zero state shows. */
  const shown = () => {
    const d = Math.floor(example() / SHOWN) * DASH_SHOWN;
    return [
      ...Array.from({ length: DASH_SHOWN }, (_, i) => dashboards[(d + i) % dashboards.length]),
      ...Array.from({ length: SHOWN }, (_, i) => examples[(example() + i) % examples.length]),
    ];
  };
  const [picking, setPicking] = createSignal(false);
  /* The graph's schema, introspected once and carried in every prompt.
   * Until it is in, the status line says so and a question waits. */
  const [schema, setSchema] = createSignal(null);
  /* Logged out, the panel shows <login> in place of the input: the shell
   * runs `yeet login` and shows the code URL, and reports when it is
   * done. Found out up front through a platform call, and again if an
   * ask comes back rejected. */
  const [loggedOut, setLoggedOut] = createSignal(false);
  const [tick, setTick] = createSignal(0);
  /* Bumped when a cell is added or released, so a lookup in the map
   * below re-runs. The map itself is plain: it is mutated in place. */
  const [generation, setGeneration] = createSignal(0);
  const [sources, setSources] = createSignal({});
  /* Columns of cards: 0 is automatic — one, then two, up to four as
   * cards arrive — and 1..4 pins it. */
  const [layout, setLayout] = createSignal(0);

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

  Promise.resolve()
    .then(() => yeet.caps())
    .then(
      () => setLoggedOut(false),
      (error) => {
        if (authError(error)) setLoggedOut(true);
        else console.warn(`askai: caps: ${error?.message ?? error}`);
      },
    );

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
  const rotate = setInterval(() => {
    if (open() && !cards().length && !draft()) setExample((i) => (i + SHOWN) % examples.length);
  }, ROTATE_MS);

  onCleanup(() => {
    clearInterval(spinner);
    clearInterval(rotate);
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

  /* × on a tile: one chart of several is cut out of its reply and its
   * cell released; the only chart, or a tile with none, takes the
   * question with it. */
  const removeTile = (tile) => {
    const { card, seg } = tile;
    if (!seg || tile.siblings <= 1) {
      remove(card.id);
      return;
    }
    const entry = cells.get(cellKey(card.id, seg));
    if (entry) {
      entry.cell.release();
      cells.delete(cellKey(card.id, seg));
      setGeneration((n) => n + 1);
    }
    const text = card.text.slice(0, seg.start) + card.text.slice(seg.end);
    patch(card.id, (c) => ({ ...c, text }));
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

  const submit = async (asked) => {
    const question = (asked ?? draft()).trim();
    if (!question || busy()) return;
    setDraft("");

    const id = nextId++;
    /* Appended: a new tile takes the next free slot of the grid. */
    setCards((all) => [...all, { id, question, text: "", error: null, repairs: 0, done: false, cancelled: false }]);
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
      if (outcome.error && authError(outcome.error)) setLoggedOut(true);
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
    for (const card of [...cards()].reverse()) {
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
    const cost = tokens ? `${tokens.input_tokens} in / ${tokens.output_tokens} out` : "";
    const charts = chartCount();
    /* `live` while the panel is open: the shell reports open and close,
     * and the charts keep sampling either way — the tag says someone is
     * looking. */
    return [cost, charts ? `${charts} chart${charts === 1 ? "" : "s"}` : "", open() ? "live" : ""]
      .filter(Boolean)
      .join(" · ");
  };

  const toggleSource = (key) => setSources((all) => ({ ...all, [key]: !all[key] }));

  /* The grid is one, over every chart from every question: a tile per
   * chart block, and a tile for a question still thinking or answered
   * without a chart. */
  const tiles = () => {
    const out = [];
    for (const card of cards()) {
      const segments = parse(card.text);
      const charts = segments.filter(isChart);
      const prose = segments
        .filter((seg) => seg.kind === "text")
        .map((seg) => seg.text)
        .join(" ");
      if (!charts.length) out.push({ card, seg: null, prose, first: true, siblings: 0 });
      else charts.forEach((seg, i) => out.push({ card, seg, prose, first: i === 0, siblings: charts.length }));
    }
    return out;
  };

  /* One tile: the question as its heading, the drawn chart, and under
   * it the model's one sentence. `props.tile` is the accessor from
   * <Index>, so a re-parse patches in place and the cell lookup follows
   * the block's key. The drawing is the shell's <chart> node: this only
   * hands it the data and the kind. */
  const Tile = (props) => {
    const tile = () => props.tile();
    const card = () => tile().card;
    const seg = () => tile().seg;
    const key = () => cellKey(card().id, seg());
    const view = () => (seg() ? entryOf(card().id, seg())?.view() ?? null : null);
    const unit = () => seg().attrs.unit;
    const single = () => view()?.order.length === 1;
    const shape = () => (view()?.points ? "points" : view()?.bars ? "rows" : "series");
    /* How the data is drawn: what the block said, else the plain
     * choice for its shape. */
    const kind = () => {
      const k = seg().attrs.kind;
      if (typeof k === "string") return k;
      if (shape() === "points") return "scatter";
      if (shape() === "rows") return "bars";
      return single() ? "area" : "overlay";
    };
    const payload = () => {
      const v = view();
      if (!v) return "{}";
      if (v.points) return JSON.stringify({ points: v.points });
      if (v.bars) return JSON.stringify({ bars: v.bars });
      const series = {};
      for (const name of v.order) series[name] = v.series[name].slice(-WINDOW);
      return JSON.stringify({ series });
    };
    /* Every chart is the same height, whatever its kind or content, so
     * tiles in a grid row line up and a gauge or a stat sits centred in
     * the same box a ranking fills — and a ranking that gains a row
     * never moves the grid. */
    const height = () => CHART_H;
    const drew = () => {
      const v = view();
      return v && (v.samples > 0 || v.bars || v.points);
    };
    const attr = (name) => (typeof seg().attrs[name] === "string" ? seg().attrs[name] : "");
    /* A question with several charts titles each by its label; the
     * question itself heads the first. */
    const several = () => tile().siblings > 1;
    const heading = () => (several() && seg() ? seg().label || "chart" : card().question);

    return (
      <column gap={2}>
        <spacer width={props.width} height={1} />
        {/* The heading wraps beside the remove button: an explicit width,
            since a text filling a row has no height until laid out. */}
        <row gap={4}>
          <text bold wrap width={props.width - CLOSE_W}>{heading()}</text>
          <button
            horizontalPadding={4}
            verticalPadding={0}
            tooltipText={several() ? "Remove this chart" : "Remove this question"}
            onClick={() => removeTile(tile())}
          >
            ×
          </button>
        </row>
        <row gap={4}>
          <Show when={seg() && !several()}>
            <text>{seg().label || ""}</text>
          </Show>
          <Show when={view() && single() && !view().bars && !view().points}>
            <text bold>{fmt(view().latest[view().order[0]], unit())}</text>
          </Show>
          <Show when={seg() && !seg().open}>
            <button
              horizontalPadding={4}
              verticalPadding={0}
              tooltipText={sources()[key()] ? "Hide the source" : "Show the source the model wrote"}
              onClick={() => toggleSource(key())}
            >
              {sources()[key()] ? "hide" : "src"}
            </button>
          </Show>
        </row>

        <Show when={seg()}>
          <Show when={seg().open}>
            <text size="caption" tone="accent">{`${spin()} writing…`}</text>
          </Show>
          {/* The source and the chart share one space: `src` swaps the chart
              for the code at the chart's height, scrolling past it, and
              `hide` swaps the chart back. The chart keeps sampling. */}
          <Show
            when={sources()[key()]}
            fallback={
              <Show when={drew()}>
                <chart
                  kind={kind()}
                  payload={payload()}
                  min={attr("min")}
                  max={attr("max")}
                  unit={attr("unit")}
                  chartWidth={props.width}
                  chartHeight={height()}
                />
              </Show>
            }
          >
            <scroll maxHeight={drew() ? height() : CODE_H} gap={0}>
              <code source={seg().script} />
            </scroll>
          </Show>
          <Show when={view()?.error}>
            <text size="caption" tone="urgent" wrap width={props.width}>{view().error}</text>
          </Show>
          <Show when={view() && !drew() && !view().error && !seg().open}>
            <text size="caption" tone="accent">{`${spin()} waiting for data…`}</text>
          </Show>
        </Show>

        <Show when={!card().done && !seg()}>
          <text size="caption" tone="accent">{`${spin()} ${status()}`}</text>
        </Show>
        <Show when={tile().prose && tile().first}>
          <text size="caption" wrap width={props.width}>{tile().prose}</text>
        </Show>
        <Show when={card().error}>
          <text size="caption" tone="urgent" wrap width={props.width}>{card().error}</text>
        </Show>
        <Show when={card().cancelled}>
          <text size="caption">— cancelled —</text>
        </Show>
      </column>
    );
  };

  /* Columns: what the layout says, else the square root of the tile
   * count — 1, then 2 from the second tile, 3 from the fifth, 4 from
   * the tenth. The panel widens to hold them. */
  const columns = () => {
    const n = tiles().length;
    if (!n) return 1;
    const wanted = layout() || Math.ceil(Math.sqrt(n));
    const fit = availW() > 0 ? Math.floor((availW() + CARD_GAP) / (CARD_W + CARD_GAP)) : MAX_COLUMNS;
    return Math.max(1, Math.min(MAX_COLUMNS, wanted, n, fit));
  };
  /* The grid scrolls within what the screen leaves under the input and
   * the status line. */
  const gridHeight = () => (availH() > 0 ? Math.max(240, availH() - 150) : 760);
  const grid = () => {
    const rows = [];
    const all = tiles();
    const per = columns();
    for (let i = 0; i < all.length; i += per) rows.push(all.slice(i, i + per));
    return rows;
  };
  const panelWidth = () => columns() * CARD_W + (columns() - 1) * CARD_GAP;
  /* One character's width in pixels, from what the panel measured. */
  const charPx = () => (panelW() > 0 && cols() > 0 ? panelW() / cols() : 8);
  const tileW = () => (panelW() > 0 ? Math.max(200, Math.floor((panelW() - (columns() - 1) * CARD_GAP) / columns())) : CARD_W);
  const layoutLabel = () => (layout() ? `${layout()}×` : `auto ${columns()}×`);

  return (
    <>
      <bar heat={busy() ? 0.5 : -1} tooltipText={`Ask AI — ${chartCount()} charts · ${model()}`}>
        {barText()}
      </bar>

      <panel
        contentWidth={panelWidth()}
        gap={6}
        onCols={(e) => {
          setCols(e.cols);
          if (e.width > 0) setPanelW(e.width);
          if (e.availableWidth > 0) setAvailW(e.availableWidth);
          if (e.availableHeight > 0) setAvailH(e.availableHeight);
        }}
        onOpen={() => {
          setOpen(true);
          setExample((i) => (i + SHOWN) % examples.length);
        }}
        onClose={() => setOpen(false)}
      >
        <Show when={loggedOut()}>
          <column gap={4} fill>
            <text bold>Log in to yeet</text>
            <text size="bodySmall" wrap fill>
              Open this link to log this host in. The input comes back on its own once you have.
            </text>
            <login
              onDone={(e) => {
                if (e.ok) setLoggedOut(false);
              }}
            />
          </column>
        </Show>

        <Show when={!loggedOut()}>
          {/* Top right: a line of its own, right-aligned across the panel. */}
          <link href="https://yeet.cx/settings" fill align="right">
            Settings
          </link>
          <input
            placeholder={shown()[0]}
            value={draft()}
            onInput={(e) => setDraft(e.value)}
            onSubmit={(e) => {
              setDraft(e.value.trim() || shown()[0]);
              submit().catch((error) => console.warn(`askai: ask failed: ${error?.message ?? error}`));
            }}
            onComplete={() => setDraft(shown()[0])}
          />

          {/* The model is a pull-down: the button names the current one and
              opens a column of the rest under it; picking one closes it.
              The layout button cycles auto, 1, 2, 3, 4 columns. */}
          <row gap={4}>
            <button
              horizontalPadding={4}
              verticalPadding={0}
              tooltipText="Choose the model"
              onClick={() => setPicking(!picking())}
            >
              {`${model()} ${picking() ? "▴" : "▾"}`}
            </button>
            <Show when={tiles().length > 1}>
              <button
                horizontalPadding={4}
                verticalPadding={0}
                tooltipText="Columns of charts: automatic, or one to four"
                onClick={() => setLayout((n) => (n + 1) % (MAX_COLUMNS + 1))}
              >
                {`⊞ ${layoutLabel()}`}
              </button>
            </Show>
            <Show when={busy()}>
              <button horizontalPadding={4} verticalPadding={0} tooltipText="Stop generating" onClick={() => agent.cancel()}>
                stop
              </button>
            </Show>
            <text size="caption" tone={busy() ? "accent" : "fg"}>{statusLine()}</text>
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
        </Show>

        {/* The zero state: three of the examples as bubbles, a click asks. */}
        <Show when={!cards().length && !loggedOut()}>
          <column gap={4}>
            <text size="bodySmall" wrap fill>{HINT}</text>
            <Index each={pack(shown(), panelW() || CARD_W, charPx())}>
              {(bubbles) => (
                <row gap={4}>
                  <Index each={bubbles()}>
                    {(question) => (
                      <button
                        bordered
                        horizontalPadding={6}
                        verticalPadding={2}
                        onClick={() => submit(question()).catch((error) => console.warn(`askai: ask failed: ${error?.message ?? error}`))}
                      >
                        {question()}
                      </button>
                    )}
                  </Index>
                </row>
              )}
            </Index>
          </column>
        </Show>

        <Show when={tiles().length > 0}>
          <scroll maxHeight={gridHeight()} gap={CARD_GAP}>
            {/* <Index> keys by position and hands down an accessor, so a
                streamed delta patches the one tile that changed. */}
            <Index each={grid()}>
              {(row) => (
                <row gap={CARD_GAP}>
                  <Index each={row()}>{(tile) => <Tile tile={tile} width={tileW()} />}</Index>
                </row>
              )}
            </Index>
          </scroll>
        </Show>

      </panel>
    </>
  );
}
