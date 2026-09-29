import { Index, Show, createSignal, onCleanup } from "yeetkit";
import { runTool, stream } from "yeet:ai";

import { createAgent } from "./agent.js";
import { createCell } from "./cells.js";
import { keyOf, parse } from "./directive.js";
import { axis, braille, clip, fmt } from "./draw.js";
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
const CHART_H = 120;
const MAX_COLUMNS = 4;
const REPAIR_WAIT = 4000; /* a chart that has not drawn or failed by then is left alone */
const MAX_REPAIRS = 2;
const LABELS = { graph_schema: "reading schema", graph_query: "querying" };

/* Example questions, each checked to come back as a chart that draws.
 * Three are shown as bubbles, one of them as the placeholder, chosen
 * afresh each time the panel opens; Enter on the empty input asks the
 * placeholder. */
const EXAMPLES = [
  "how busy is the cpu?",
  "how busy is each cpu core?",
  "how is memory split between used, cached and free?",
  "which processes use the most memory?",
  "how much network traffic is there?",
  "how full is the swap?",
  "what is the load average over 1, 5 and 15 minutes?",
  "how many tcp connections are there, by state?",
  "how do processes compare on memory against threads?",
  "how many processes and threads are running?",
];
const SHOWN = 3; /* bubbles on show at once, from the ten */

const HINT = "Pick one, or type your own. The model writes a subscription over the system graph and the panel draws what arrives.";

/* Bubbles packed into rows by their text width, so a row holds as many
 * as the grid allows. Each bubble spends its label plus this much on
 * padding. */
const BUBBLE_PAD = 4;
const pack = (labels, cols) => {
  const rows = [];
  let row = [];
  let used = 0;
  for (const label of labels) {
    const w = label.length + BUBBLE_PAD;
    if (row.length && used + w > cols) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(label);
    used += w;
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
  const examples = shuffle(EXAMPLES);
  const [example, setExample] = createSignal(0);
  /* The three from the current one on. Chosen once per opening of the
   * panel — the next three each time — and still while it is open. */
  const shown = () => Array.from({ length: SHOWN }, (_, i) => examples[(example() + i) % examples.length]);
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

  const submit = async (asked) => {
    const question = (asked ?? draft()).trim();
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

  /* One chart: a header line, then the drawn chart. `props.seg` is the
   * block's accessor from <Index>, so a re-parse patches the label and
   * the cell lookup follows the block's key. The drawing is the shell's
   * <chart> node: this only hands it the data and the kind. */
  const Chart = (props) => {
    const seg = () => props.seg();
    const key = () => cellKey(props.cardId, seg());
    const view = () => entryOf(props.cardId, seg())?.view() ?? null;
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
    const height = () => {
      const v = view();
      if (!v) return CHART_H;
      if (v.bars) return Math.max(60, Math.min(260, 22 * v.bars.length + 8));
      if (kind() === "split" || kind() === "sparks") return Math.max(CHART_H, 44 * v.order.length);
      if (kind() === "heat") return Math.max(60, Math.min(260, 16 * v.order.length + 8));
      return CHART_H;
    };
    const drew = () => {
      const v = view();
      return v && (v.samples > 0 || v.bars || v.points);
    };
    const attr = (name) => (typeof seg().attrs[name] === "string" ? seg().attrs[name] : "");

    return (
      <column gap={2}>
        <row gap={4}>
          <Show
            when={view() && single() && !view().bars && !view().points}
            fallback={<text bold>{clip(seg().label || "chart", props.cols - BUTTON_COLS)}</text>}
          >
            <text bold>{clip(seg().label || "chart", props.cols - BUTTON_COLS - 9)}</text>
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
          <text size="caption" tone="accent">{`${spin()} writing…`}</text>
        </Show>
        <Show when={sources()[key()]}>
          <text size="caption" wrap fill>{seg().script}</text>
        </Show>

        <Show when={drew()}>
          <chart
            kind={kind()}
            payload={payload()}
            min={attr("min")}
            max={attr("max")}
            unit={attr("unit")}
            chartWidth={CARD_W}
            chartHeight={height()}
          />
        </Show>

        <Show when={view()?.error}>
          <text size="caption" tone="urgent" wrap fill>{view().error}</text>
        </Show>
        <Show when={view() && !drew() && !view().error && !seg().open}>
          <text size="caption" tone="accent">{`${spin()} waiting for data…`}</text>
        </Show>
      </column>
    );
  };

  /* One card: the question, the prose, its charts. Pinned to the card
   * width by a spacer, so a card still thinking is as wide as one that
   * has drawn and the grid holds. */
  const Card = (props) => {
    const card = () => props.card();
    return (
      <column gap={2}>
        <spacer width={CARD_W} height={1} />
        <row gap={4}>
          <text bold>{clip(`;; ${card().question}`, props.cols - BUTTON_COLS)}</text>
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
              <Chart seg={seg} cardId={card().id} cols={props.cols} />
            </Show>
          )}
        </Index>

        <Show when={!card().done && !card().text}>
          <text size="caption" tone="accent">{`${spin()} ${status()}`}</text>
        </Show>
        <Show when={card().error}>
          <text size="caption" tone="urgent" wrap fill>{card().error}</text>
        </Show>
        <Show when={card().cancelled}>
          <text size="caption">— cancelled —</text>
        </Show>
      </column>
    );
  };

  /* The grid: as many columns as the layout says, else the square root
   * of the card count — 1, then 2 from the second card, 3 from the
   * fifth, 4 from the tenth. The panel widens to hold them. */
  const columns = () => {
    const n = cards().length;
    if (!n) return 1;
    const wanted = layout() || Math.ceil(Math.sqrt(n));
    return Math.max(1, Math.min(MAX_COLUMNS, wanted, n));
  };
  const grid = () => {
    const rows = [];
    const all = cards();
    const per = columns();
    for (let i = 0; i < all.length; i += per) rows.push(all.slice(i, i + per));
    return rows;
  };
  const panelWidth = () => columns() * CARD_W + (columns() - 1) * CARD_GAP;
  /* The character grid one card gets: the panel's columns shared out. */
  const cardCols = () => Math.max(20, Math.floor((cols() - (columns() - 1) * 2) / columns()));
  const layoutLabel = () => (layout() ? `${layout()}×` : `auto ${columns()}×`);

  return (
    <>
      <bar heat={busy() ? 0.5 : -1} tooltipText={`Ask AI — ${chartCount()} charts · ${model()}`}>
        {barText()}
      </bar>

      <panel
        contentWidth={panelWidth()}
        gap={6}
        onCols={(e) => setCols(e.cols)}
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
          <input
            placeholder={examples[example()]}
            value={draft()}
            onInput={(e) => setDraft(e.value)}
            onSubmit={(e) => {
              setDraft(e.value.trim() || examples[example()]);
              submit().catch((error) => console.warn(`askai: ask failed: ${error?.message ?? error}`));
            }}
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
            <Show when={cards().length > 1}>
              <button
                horizontalPadding={4}
                verticalPadding={0}
                tooltipText="Columns of charts: automatic, or one to four"
                onClick={() => setLayout((n) => (n + 1) % (MAX_COLUMNS + 1))}
              >
                {`⊞ ${layoutLabel()}`}
              </button>
            </Show>
            <text size="caption" tone={busy() ? "accent" : "fg"}>{statusLine()}</text>
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
        </Show>

        {/* The zero state: three of the examples as bubbles, a click asks. */}
        <Show when={!cards().length && !loggedOut()}>
          <column gap={4}>
            <text size="bodySmall" wrap fill>{HINT}</text>
            <Index each={pack(shown(), cols())}>
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

        <Show when={cards().length > 0}>
          <scroll maxHeight={720} gap={6}>
            {/* <Index> keys by position and hands down an accessor, so a
                streamed delta patches the one card that changed. */}
            <Index each={grid()}>
              {(row, r) => (
                <column gap={4}>
                  <Show when={r > 0}>
                    <separator />
                  </Show>
                  <row gap={CARD_GAP}>
                    <Index each={row()}>{(card) => <Card card={card} cols={cardCols()} />}</Index>
                  </row>
                </column>
              )}
            </Index>
          </scroll>
        </Show>
      </panel>
    </>
  );
}
