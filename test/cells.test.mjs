import assert from "node:assert/strict";
import { test } from "node:test";

import { compile, createCell } from "../app/cells.js";
import { parse } from "../app/directive.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/* A graph whose subscriptions are driven by the test. */
const fakeGraph = () => {
  const subs = new Map();
  let n = 0;
  return {
    subs,
    query: async (q) => (q.includes("bad") ? { errors: [{ message: "Unknown field" }] } : { data: { ok: q } }),
    subscribe: async (q, cb) => {
      if (q.includes("reject")) throw new Error("parse error at 1:1");
      const ticket = `t${++n}`;
      subs.set(ticket, { q, cb });
      return ticket;
    },
    unsubscribe: async (t) => subs.delete(t),
    push: (data) => {
      for (const { cb } of subs.values()) cb(data);
    },
  };
};

const block = (script, attrs = "") => parse(`:::chart[t]${attrs}\n\`\`\`js\n${script}\n\`\`\`\n::`)[0];

test("compile: expression bodies and statement bodies both run", async () => {
  assert.equal(await compile(["x"], "x * 2")(21), 42);
  assert.equal(await compile(["x"], "const y = x; return y + 1")(1), 2);
  assert.throws(() => compile([], "const ="));
});

test("a subscribing body plots each sample and is torn down on release", async () => {
  const graph = fakeGraph();
  const views = [];
  const cell = createCell(
    block("subscribe(`subscription { m(interval_ms: 1000) { v } }`, (d) => plot(d.m.v));"),
    { graph, notify: (v) => views.push({ ...v }) },
  );
  cell.run();
  await tick();
  await tick();
  assert.equal(graph.subs.size, 1);
  graph.push({ data: { m: { v: 3 } } });
  graph.push({ m: { v: 5 } });
  assert.deepEqual(cell.view.series.value, [3, 5]);
  assert.equal(cell.view.latest.value, 5);
  assert.equal(cell.view.samples, 2);
  assert.equal(cell.view.error, null);
  assert.ok(views.length >= 2);
  cell.release();
  await tick();
  assert.equal(graph.subs.size, 0);
});

test("plot: objects become several series, arrays become bars, null is nothing", async () => {
  const plotting = (v) => createCell(block(`plot(${JSON.stringify(v)})`), { graph: fakeGraph() });
  const multi = plotting({ rx: 1, tx: "2", bad: "x" });
  await multi.run();
  assert.deepEqual(multi.view.order, ["rx", "tx"]);
  assert.deepEqual(multi.view.series.tx, [2]);
  const ranked = plotting([{ label: "a", value: 1 }, { name: "b", value: 2 }]);
  await ranked.run();
  assert.deepEqual(ranked.view.bars, [{ label: "a", value: 1 }, { label: "b", value: 2 }]);
  assert.equal(ranked.view.samples, 1);
  const nothing = plotting(null);
  await nothing.run();
  assert.equal(nothing.view.samples, 0);
  assert.equal(nothing.view.error, null);
});

test("a returned value is plotted, and live= re-runs the body", async (t) => {
  let now = 0;
  const cell = createCell(block("state.n = (state.n ?? 0) + 1; return state.n;", "{live=1}"), {
    graph: fakeGraph(),
    now: () => now,
  });
  t.after(() => cell.release());
  cell.run();
  await tick();
  assert.deepEqual(cell.view.series.value, [1]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(cell.view.series.value.length >= 2, "re-ran on the interval (floored at 250ms)");
  cell.release();
  const seen = cell.view.series.value.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(cell.view.series.value.length, seen, "stopped on release");
});

test("rate: per-second change of a counter against wall time", async (t) => {
  let now = 1000;
  const cell = createCell(block("plot(rate('rx', state.c = (state.c ?? 0) + 500))", "{live=1}"), {
    graph: fakeGraph(),
    now: () => now,
  });
  t.after(() => cell.release());
  cell.run();
  await tick();
  assert.deepEqual(cell.view.series.value ?? [], [], "null on the first call is not plotted");
  now = 1500;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(cell.view.series.value, [1000]);
  cell.release();
});

test("failures land on the view: syntax, thrown, rejected subscription, error envelope, callback throw", async () => {
  const graph = fakeGraph();
  const syntax = createCell(block("const ="), { graph });
  await syntax.run();
  assert.match(syntax.view.error, /^syntax:/);

  const thrown = createCell(block("throw new Error('nope')"), { graph });
  await thrown.run();
  assert.equal(thrown.view.error, "nope");

  const gql = createCell(block("await graph('{ bad }')"), { graph });
  await gql.run();
  assert.equal(gql.view.error, "Unknown field");

  const rejected = createCell(block("subscribe('subscription { reject }', () => {})"), { graph });
  await rejected.run();
  await tick();
  assert.equal(rejected.view.error, "parse error at 1:1");

  const envelope = createCell(block("subscribe('subscription { x }', (d) => plot(d.x))"), { graph });
  await envelope.run();
  await tick();
  graph.push({ __error: "stream lagged" });
  assert.equal(envelope.view.error, "subscription: stream lagged");

  const throwing = createCell(block("subscribe('subscription { y }', (d) => { throw new Error('in cb') })"), { graph });
  await throwing.run();
  await tick();
  graph.push({ y: 1 });
  assert.equal(throwing.view.error, "in cb");
  assert.equal(throwing.view.samples, 0);
});

test("a body that never settles times out rather than hanging the cell", { timeout: 15000 }, async () => {
  const cell = createCell(block("await new Promise(() => {})"), { graph: fakeGraph() });
  const started = Date.now();
  await cell.run();
  assert.match(cell.view.error, /longer than/);
  assert.ok(Date.now() - started >= 9000);
});

test("onCleanup and timers registered by the body stop on release", async () => {
  let cleaned = 0;
  let ticks = 0;
  const graph = fakeGraph();
  const cell = createCell(block("setInterval(() => plot(1), 10); onCleanup(() => cleanup())"), {
    graph,
  });
  /* `cleanup` is not in scope by default; the body reaches it through
   * the prototype-free global here for the test only. */
  globalThis.cleanup = () => (cleaned += 1);
  await cell.run();
  await new Promise((r) => setTimeout(r, 60));
  ticks = cell.view.samples;
  assert.ok(ticks >= 2);
  cell.release();
  assert.equal(cleaned, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cell.view.samples, ticks);
  delete globalThis.cleanup;
});
