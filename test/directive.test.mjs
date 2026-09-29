import assert from "node:assert/strict";
import { test } from "node:test";

import { attributes, keyOf, parse, render, scriptOf } from "../app/directive.js";

const REPLY = `CPU as a percentage, one sample a second.

:::chart[cpu]{min=0 max=100 unit=%}
\`\`\`js
subscribe(\`subscription { load_average(interval_ms: 1000) { one } }\`, (d) => plot(d.load_average.one));
\`\`\`
::
`;

test("attributes: bare, quoted, id and class", () => {
  assert.deepEqual(attributes('live=1000 unit="%" #cpu .wide fixed name=\'a b\''), {
    live: "1000",
    unit: "%",
    id: "cpu",
    class: "wide",
    fixed: true,
    name: "a b",
  });
  assert.deepEqual(attributes(""), {});
  assert.deepEqual(attributes(undefined), {});
});

test("parse: prose then a closed block", () => {
  const segments = parse(REPLY);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].kind, "text");
  assert.equal(segments[0].text, "CPU as a percentage, one sample a second.");
  const block = segments[1];
  assert.equal(block.kind, "block");
  assert.equal(block.name, "chart");
  assert.equal(block.label, "cpu");
  assert.deepEqual(block.attrs, { min: "0", max: "100", unit: "%" });
  assert.equal(block.open, false);
  assert.match(block.script, /^subscribe\(/);
  assert.ok(!block.script.includes("```"));
  assert.equal(REPLY.slice(block.start, block.end).split("\n")[0], ":::chart[cpu]{min=0 max=100 unit=%}");
  assert.equal(REPLY.slice(block.start, block.end).trimEnd().endsWith("::"), true);
});

test("parse: a streaming reply leaves the last block open", () => {
  const half = REPLY.slice(0, REPLY.indexOf("plot("));
  const segments = parse(half);
  const block = segments.at(-1);
  assert.equal(block.kind, "block");
  assert.equal(block.open, true);
  assert.match(block.script, /^subscribe\(/);
  assert.equal(block.end, half.length);
});

test("parse: a bare body and a ::: closer both work", () => {
  const segments = parse(":::chart[x]\nplot(1)\n:::\nafter");
  assert.equal(segments[0].script, "plot(1)");
  assert.equal(segments[0].open, false);
  assert.equal(segments[1].text, "after");
});

test("parse: several blocks, several fences", () => {
  const text = ":::chart[a]\n```js\nplot(1)\n```\n::\n:::chart[b]{rows=2}\n```js\nlet x = 1;\n```\n\n```js\nplot(x)\n```\n::";
  const segments = parse(text);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].label, "a");
  assert.equal(segments[1].label, "b");
  assert.equal(segments[1].attrs.rows, "2");
  assert.equal(segments[1].script, "let x = 1;\n\nplot(x)");
});

test("scriptOf: a fence wins over prose beside it", () => {
  assert.equal(scriptOf(["some words", "```js", "plot(2 * 3)", "```", "more words"]), "plot(2 * 3)");
  assert.equal(scriptOf(["plot(_x_)"]), "plot(_x_)");
});

test("keyOf: code is identity, id wins", () => {
  const a = parse(REPLY)[1];
  const b = parse(REPLY)[1];
  assert.equal(keyOf(a), keyOf(b));
  assert.notEqual(keyOf({ script: "plot(1)" }), keyOf({ script: "plot(2)" }));
  assert.equal(keyOf({ attrs: { id: "cpu" }, script: "anything" }), "id:cpu");
});

test("render: round-trips through parse", () => {
  const block = parse(REPLY)[1];
  const again = parse(render(block))[0];
  assert.equal(again.label, block.label);
  assert.deepEqual(again.attrs, block.attrs);
  assert.equal(again.script, block.script);
});

test("parse: an empty or missing reply is no segments", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse(undefined), []);
});
