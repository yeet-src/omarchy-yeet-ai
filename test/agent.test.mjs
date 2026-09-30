import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgent } from "../app/agent.js";
import { createTools } from "../app/tools.js";

/* A scripted `stream()`: each call yields the next scripted turn's
 * events and resolves `result` from them, the way yeet:ai's AiStream
 * does. Requests are recorded so the test can read what the model
 * would have been sent. */
const scripted = (turns) => {
  const requests = [];
  const stream = (request) => {
    /* Snapshot: the agent keeps appending to the same messages array. */
    requests.push({ ...request, messages: [...request.messages] });
    const events = turns.shift() ?? [];
    let text = "";
    const tool_calls = [];
    for (const e of events) {
      if (e.type === "text") text += e.delta;
      if (e.type === "tool_call") tool_calls.push({ id: e.id, name: e.name, arguments: e.arguments });
    }
    let cancelled = false;
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) {
          if (cancelled) return;
          yield e;
        }
      },
      result: Promise.resolve({ text, tool_calls, usage: null, stop_reason: "end" }),
      cancel: async () => {
        cancelled = true;
      },
    };
  };
  return { stream, requests };
};

const runTool = async (tools, call) => {
  const match = tools.find((t) => t.name === call.name);
  return { tool_call_id: call.id, name: call.name, result: await match.handler(call.arguments ?? {}) };
};

const fakeGraph = async (q) => {
  if (q.includes("__schema")) {
    return {
      data: {
        __schema: {
          queryType: {
            fields: [
              { name: "meminfo", description: "Memory", args: [{ name: "interval_ms", type: { kind: "SCALAR", name: "Int" } }], type: { kind: "OBJECT", name: "Meminfo" } },
            ],
          },
        },
      },
    };
  }
  if (q.includes("__type")) {
    return { data: { __type: { kind: "OBJECT", description: null, fields: [{ name: "mem_total", args: [], type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "Int" } } }], inputFields: null, enumValues: null } } };
  }
  if (q.includes("bad")) return { data: null, errors: [{ message: "Unknown field bad" }] };
  return { data: { meminfo: { mem_total: 1 } } };
};

test("tools: schema renders the root and a type; a rejected query is data", async () => {
  const { tools } = createTools(fakeGraph);
  const schema = await tools[0].handler({ type: "Meminfo" });
  assert.match(schema.schema, /type Query \{\n  meminfo\(interval_ms: Int\): Meminfo  # Memory\n\}/);
  assert.match(schema.schema, /type Meminfo \{\n  mem_total: Int!\n\}/);
  assert.deepEqual(await tools[1].handler({ query: "{ meminfo { mem_total } }" }), { meminfo: { mem_total: 1 } });
  assert.deepEqual(await tools[1].handler({ query: "{ bad }" }), { error: "Unknown field bad" });
});

test("agent: a turn with a tool call, then the answer; history keeps only the pair", async () => {
  const { stream, requests } = scripted([
    [
      { type: "text", delta: "Let me look." },
      { type: "tool_call", id: "c1", name: "graph_schema", arguments: {} },
    ],
    [
      { type: "text", delta: "Memory.\n\n:::chart[mem]\n```js\nplot(1)\n```\n::" },
      { type: "usage", input_tokens: 10, output_tokens: 5 },
    ],
  ]);
  const { tools } = createTools(fakeGraph);
  const seen = { text: [], tools: [], results: [], usage: null, answer: null };
  const agent = createAgent({
    model: "m",
    system: "SYS",
    tools,
    stream,
    runTool,
    on: {
      text: (delta, whole) => seen.text.push([delta, whole]),
      tool: (call) => seen.tools.push(call.name),
      toolResult: (_call, result) => seen.results.push(result),
      usage: (u) => (seen.usage = u),
      answer: (text, outcome) => (seen.answer = { text, outcome }),
    },
  });

  const outcome = await agent.ask("memory", { context: "48 wide" });
  assert.equal(outcome.error, null);
  assert.equal(outcome.cancelled, false);
  assert.match(outcome.text, /^Memory\./);
  assert.deepEqual(seen.tools, ["graph_schema"]);
  assert.match(seen.results[0].schema, /type Query/);
  assert.equal(seen.usage.output_tokens, 5);
  /* the interim "Let me look." was cleared before the answer streamed */
  assert.deepEqual(seen.text[1], ["", ""]);
  assert.equal(seen.answer.text, outcome.text);

  assert.equal(requests[0].system, "SYS\n\n48 wide");
  assert.equal(requests[0].tools.length, 2);
  assert.equal(requests[1].messages.at(-1).role, "user");
  assert.match(requests[1].messages.at(-1).content, /"tool_call_id":"c1"/);

  /* next question: only the question/answer pair carried over */
  await agent.ask("and swap?");
  assert.deepEqual(
    requests[2].messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.equal(requests[2].messages[0].content, "memory");
});

test("agent: an error settles the turn and is reported; remember:false leaves no history", async () => {
  const { stream, requests } = scripted([]);
  const broken = (request) => {
    stream(request);
    const error = Object.assign(new Error("not logged in"), { code: "AI_UNAUTHENTICATED" });
    return {
      async *[Symbol.asyncIterator]() {
        throw error;
      },
      result: Promise.reject(error).catch(() => ({})),
      cancel: async () => {},
    };
  };
  const errors = [];
  const agent = createAgent({ model: "m", system: "S", tools: [], stream: broken, runTool, on: { error: (m) => errors.push(m) } });
  const outcome = await agent.ask("x", { remember: false });
  assert.equal(outcome.error, "AI_UNAUTHENTICATED: not logged in");
  assert.deepEqual(errors, ["AI_UNAUTHENTICATED: not logged in"]);
  await agent.ask("y");
  assert.equal(requests.at(-1).messages.length, 1);
});

test("agent: a second ask while busy is refused, per-ask hooks override", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = () => ({
    async *[Symbol.asyncIterator]() {
      await gate;
      yield { type: "text", delta: "done" };
    },
    result: gate.then(() => ({ text: "done", tool_calls: [], usage: null, stop_reason: "end" })),
    cancel: async () => {},
  });
  const seen = [];
  const agent = createAgent({ model: "m", system: "S", tools: [], stream: slow, runTool, on: { text: () => seen.push("default") } });
  const first = agent.ask("a", { on: { text: () => seen.push("override") } });
  assert.equal(agent.busy, true);
  assert.equal((await agent.ask("b")).error, "busy");
  release();
  await first;
  assert.deepEqual(seen, ["override"]);
  assert.equal(agent.busy, false);
});

/* A stream that fails at setup, the way yeet:ai's does when the daemon
 * gave up on the platform call: the iterator throws and result rejects. */
const refused = (error) => ({
  async *[Symbol.asyncIterator]() {
    throw error;
  },
  result: Promise.reject(error).catch(() => ({})),
  cancel: async () => {},
});

test("agent: a turn refused before any event is asked again until it is accepted", async () => {
  const error = Object.assign(new Error("API request failed: HTTPS Request Timeout Exceeded: 15s."), {
    code: "PLATFORM_CALL_API_ERROR",
  });
  const { stream: fine, requests } = scripted([[{ type: "text", delta: "ok" }]]);
  let calls = 0;
  const stream = (request) => (++calls <= 2 ? refused(error) : fine(request));
  const retries = [];
  const errors = [];
  const agent = createAgent({
    model: "m",
    system: "S",
    tools: [],
    stream,
    runTool,
    retryDelay: () => 1,
    on: { retry: (n, why) => retries.push([n, why]), error: (m) => errors.push(m) },
  });
  const outcome = await agent.ask("q");
  assert.equal(outcome.text, "ok");
  assert.equal(outcome.error, null);
  assert.equal(outcome.cancelled, false);
  const why = "PLATFORM_CALL_API_ERROR: API request failed: HTTPS Request Timeout Exceeded: 15s.";
  assert.deepEqual(retries, [[1, why], [2, why]]);
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 1);
  assert.equal(calls, 3);
});

test("agent: stop during the wait between attempts settles as cancelled", async () => {
  const error = Object.assign(new Error("The server is rate limiting platform calls."), { code: "PLATFORM_CALL_RATE_LIMITED" });
  const agent = createAgent({
    model: "m",
    system: "S",
    tools: [],
    stream: () => refused(error),
    runTool,
    retryDelay: () => 60_000,
    on: { retry: () => setTimeout(() => agent.cancel(), 5) },
  });
  const outcome = await agent.ask("q");
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.error, null);
});

test("agent: a login error and a failure after text has arrived are not retried", async () => {
  const auth = Object.assign(new Error("WhoAmI is not set."), { code: "PLATFORM_CALL_WHOAMI_NOT_SET" });
  const retries = [];
  let agent = createAgent({ model: "m", system: "S", tools: [], stream: () => refused(auth), runTool, retryDelay: () => 1, on: { retry: (n) => retries.push(n) } });
  assert.equal((await agent.ask("q")).error, "PLATFORM_CALL_WHOAMI_NOT_SET: WhoAmI is not set.");

  const late = Object.assign(new Error("gone"), { code: "PLATFORM_CALL_API_ERROR" });
  const midway = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "text", delta: "half" };
      throw late;
    },
    result: Promise.reject(late).catch(() => ({})),
    cancel: async () => {},
  });
  agent = createAgent({ model: "m", system: "S", tools: [], stream: midway, runTool, retryDelay: () => 1, on: { retry: (n) => retries.push(n) } });
  const outcome = await agent.ask("q");
  assert.equal(outcome.error, "PLATFORM_CALL_API_ERROR: gone");
  assert.equal(outcome.text, "half");
  assert.deepEqual(retries, []);
});
