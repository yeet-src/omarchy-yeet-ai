/* Ask one question from a terminal, with no shell in the loop.
 *
 *   yeet run scripts/ask.js "network throughput"
 *   yeet run scripts/ask.js --seconds 8 "top processes by memory"
 *
 * The same agent, prompt, tools and cell runtime the panel uses, so a
 * change to any of them can be tried against a real model and a real
 * system graph without an Omarchy shell. The reply is printed as it
 * streams, every `:::chart` block is then run for a few seconds, and
 * what it plotted is printed — or the error it failed with, which is
 * what the panel would have handed back for repair.
 */

import { runTool, stream } from "yeet:ai";

import { createAgent } from "../app/agent.js";
import { createCell } from "../app/cells.js";
import { parse } from "../app/directive.js";
import { SYSTEM, context } from "../app/prompt.js";
import { createTools } from "../app/tools.js";

const question = yeet.args._.join(" ").trim();
if (!question) {
  console.log('usage: yeet run scripts/ask.js [--model m] [--seconds n] "question"');
  yeet.exit();
}
const model = yeet.args.model ?? "claude-sonnet-5";
const seconds = Number(yeet.args.seconds) || 6;

const graph = {
  query: (q) => yeet.graph.query(q),
  subscribe: (q, cb) => yeet.graph.subscribe(q, cb),
  unsubscribe: (t) => yeet.graph.unsubscribe(t),
};

const { tools } = createTools(graph.query);
const agent = createAgent({
  model,
  system: SYSTEM,
  tools,
  stream,
  runTool,
  on: {
    /* Deltas are a few characters each and console.log ends a line,
     * so the reply is printed whole once it has settled. */
    text: () => {},
    tool: (call) => console.log(`\n⏵ ${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 100)}`),
    toolResult: (_call, result) => console.log(`✓ ${JSON.stringify(result).slice(0, 160)}\n`),
    usage: (u) => console.log(`\n· ${u.input_tokens}in/${u.output_tokens}out`),
    error: (m) => console.log(`\n✗ ${m}`),
  },
});

console.log(`? ${question}  (${model})\n`);
const outcome = await agent.ask(question, { context: context(48) });
console.log(outcome.text);
console.log("\n----");

const blocks = parse(outcome.text).filter((s) => s.kind === "block" && s.name === "chart");
if (!blocks.length) {
  console.log("no :::chart block in the reply");
  yeet.exit();
}

const cells = blocks.map((block) => {
  const cell = createCell(block, { graph });
  cell.run();
  return cell;
});

await new Promise((r) => setTimeout(r, seconds * 1000));

for (const cell of cells) {
  const { block, view } = cell;
  console.log(`\n[${block.label || "chart"}] ${JSON.stringify(block.attrs)}`);
  if (view.error) console.log(`  ✗ ${view.error}`);
  if (view.bars) for (const row of view.bars) console.log(`  ${row.label.padEnd(20)} ${row.value}`);
  for (const name of view.order) {
    const s = view.series[name];
    console.log(`  ${name}: ${s.length} samples, latest ${s.at(-1)}, min ${Math.min(...s)}, max ${Math.max(...s)}`);
  }
  if (!view.error && !view.samples) console.log("  (nothing plotted)");
  cell.release();
}

yeet.exit();
