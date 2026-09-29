import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSchema, renderType } from "../app/schema.js";

const scalar = (name) => ({ kind: "SCALAR", name, ofType: null });
const nonNull = (of) => ({ kind: "NON_NULL", name: null, ofType: of });
const list = (of) => ({ kind: "LIST", name: null, ofType: of });
const obj = (name) => ({ kind: "OBJECT", name, ofType: null });

const TYPES = {
  Query: {
    name: "Query",
    fields: [
      { name: "procs", description: "Every process", args: [{ name: "interval_ms", type: scalar("Int") }], type: nonNull(list(nonNull(obj("Process")))) },
      { name: "meminfo", description: null, args: [], type: nonNull(obj("Meminfo")) },
    ],
  },
  Process: {
    name: "Process",
    fields: [
      { name: "pid", args: [], type: nonNull(scalar("Int")) },
      { name: "stat", description: "Null when the process exited between the listing and the read, which happens.", args: [], type: obj("Stat") },
      { name: "state", args: [], type: { kind: "ENUM", name: "State", ofType: null } },
    ],
  },
  Stat: { name: "Stat", fields: [{ name: "rss_bytes", args: [], type: nonNull(scalar("Int")) }] },
  Meminfo: { name: "Meminfo", fields: [{ name: "mem_total", args: [], type: nonNull(scalar("Int")) }] },
  State: { name: "State", enumValues: [{ name: "RUNNING" }, { name: "SLEEPING" }] },
};

const fakeGraph = async (q) => {
  if (q.includes("__schema")) {
    return {
      data: {
        __schema: {
          queryType: { name: "Query" },
          types: [
            ...Object.keys(TYPES).map((name) => ({ name, kind: name === "State" ? "ENUM" : "OBJECT" })),
            { name: "Int", kind: "SCALAR" },
            { name: "__Type", kind: "OBJECT" },
          ],
        },
      },
    };
  }
  const name = /__type\(name: "([^"]+)"\)/.exec(q)[1];
  return { data: { __type: TYPES[name] ?? null } };
};

test("loadSchema walks from the root and renders nullability, args, enums and clipped descriptions", async () => {
  const schema = await loadSchema(fakeGraph);
  assert.equal(schema.root, "Query");
  assert.deepEqual(schema.fields, ["procs", "meminfo"]);
  assert.equal(schema.types, 5);
  assert.equal(schema.bytes, schema.sdl.length);
  assert.match(schema.sdl, /^type Query \{\n  procs\(interval_ms: Int\): \[Process!\]!  # Every process\n  meminfo: Meminfo!\n\}/);
  assert.match(schema.sdl, /type Process \{\n  pid: Int!\n  stat: Stat  # Null when the process exited between the listing and the read, which happens\.\n  state: State\n\}/);
  assert.match(schema.sdl, /enum State \{ RUNNING \| SLEEPING \}/);
  /* root-first: Query is rendered before anything it reaches */
  assert.ok(schema.sdl.indexOf("type Query") < schema.sdl.indexOf("type Process"));
  assert.ok(!schema.sdl.includes("__Type"));
});

test("renderType: a type with no fields renders nothing, a long description is clipped", () => {
  assert.equal(renderType({ name: "Empty", fields: [] }, "OBJECT"), null);
  const long = "x".repeat(200);
  const out = renderType({ name: "T", fields: [{ name: "f", description: long, args: [], type: scalar("Int") }] }, "OBJECT");
  assert.match(out, /# x{90}…\n\}$/);
});
