import assert from "node:assert/strict";
import { test } from "node:test";

import { axis, bars, braille, bytes, compact, fmt, line, rowHeat } from "../app/draw.js";

test("braille: every line is exactly width characters of braille", () => {
  const lines = braille([0, 50, 100, 25], 10, 0, 100, 4);
  assert.equal(lines.length, 4);
  for (const l of lines) {
    assert.equal(l.length, 10);
    for (const ch of l) assert.ok(ch.charCodeAt(0) >= 0x2800 && ch.charCodeAt(0) <= 0x28ff);
  }
});

test("braille: samples fill from the right and a full sample lights the top row", () => {
  const lines = braille([100], 4, 0, 100, 2);
  assert.equal(lines[0].slice(0, 3), "⠀⠀⠀");
  assert.notEqual(lines[0][3], "⠀");
  const empty = braille([], 4, 0, 100, 2);
  assert.deepEqual(empty, ["⠀⠀⠀⠀", "⠀⠀⠀⠀"]);
});

test("braille: a zero sample still draws a baseline dot", () => {
  const [top, bottom] = braille([0], 1, 0, 100, 2);
  assert.equal(top, "⠀");
  assert.notEqual(bottom, "⠀");
});

test("axis: fixed, framed, and floored at zero for non-negative data", () => {
  assert.deepEqual(axis([5, 10], 0, 100), { lo: 0, hi: 100 });
  const framed = axis([10, 20]);
  assert.ok(framed.lo < 10 && framed.hi > 20);
  assert.ok(framed.lo >= 0);
  const flat = axis([50, 50, 50]);
  assert.ok(flat.lo < 50 && flat.hi > 50);
  assert.deepEqual(axis([]), { lo: 0, hi: 1 });
  assert.equal(axis([3, 4], 0).lo, 0);
});

test("bars: one line per row, exactly width wide, scaled to the largest", () => {
  const lines = bars([{ label: "chrome", value: 2048 }, { label: "a-very-long-process-name-here", value: 1024 }], 40, "B");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal([...l].length, 40);
  assert.ok(lines[0].includes("█"));
  assert.ok(lines[0].endsWith("2K"));
  assert.ok(lines[1].includes("…"));
});

test("fmt: units", () => {
  assert.equal(fmt(42.4, "%"), "42%");
  assert.equal(fmt(3.14159, "%"), "3.1%");
  assert.equal(fmt(1048576 * 1.5, "B"), "1.5M");
  assert.equal(fmt(2048, "B/s"), "2K/s");
  assert.equal(fmt(12, "ms"), "12.0ms");
  assert.equal(fmt(1234567), "1.2M");
  assert.equal(fmt(null), "–");
  assert.equal(fmt("x"), "–");
});

test("bytes and compact", () => {
  assert.equal(bytes(512), "512B");
  assert.equal(bytes(3 * 1073741824), "3.0G");
  assert.equal(compact(0.5), "0.50");
  assert.equal(compact(7), "7");
  assert.equal(compact(12345), "12k");
});

test("line: left elides, right aligned, exact width", () => {
  const l = line("a label that is far too long for the room", "42%", 20);
  assert.equal([...l].length, 20);
  assert.ok(l.endsWith(" 42%"));
  assert.ok(l.includes("…"));
  assert.equal(line("cpu", "9", 10), "cpu      9");
});

test("rowHeat: top hot, bottom warm, single row full", () => {
  assert.equal(rowHeat(0, 4), 1);
  assert.ok(Math.abs(rowHeat(3, 4) - 0.45) < 1e-9);
  assert.equal(rowHeat(0, 1), 1);
});

import { chart, stackedTotals } from "../app/draw.js";

const dots = (line) => [...line].map((ch) => ch.charCodeAt(0) - 0x2800);

test("chart line: a jump between samples is drawn as a vertical run", () => {
  /* two samples in one cell: low then high — the right column must light
   * every dot between, and the left only its own level */
  const [top, bottom] = chart([[0, 100]], 1, 0, 100, 2);
  assert.deepEqual([top, bottom], braille([0, 100], 1, 0, 100, 2), "area is the default");
  const [ltop, lbottom] = chart([[0, 100]], 1, 0, 100, 2, "line");
  assert.equal(dots(lbottom)[0] & 0x01, 0, "left column bottom: only the lowest dot (0x40)");
  assert.equal(dots(lbottom)[0] & 0x40, 0x40);
  assert.equal(dots(ltop)[0] & 0x80, 0x80, "right column reaches the top");
  assert.equal(dots(lbottom)[0] & 0x08, 0x08, "and lights the run below it");
  const [ftop] = chart([[100, 100]], 1, 0, 100, 2, "line");
  assert.equal(dots(ftop)[0], 0x01 | 0x08, "a flat line is one dot per column");
});

test("chart stacked: bands are separated by an unlit edge and share the total's axis", () => {
  const [line] = chart([[25], [25]], 1, 0, 100, 1, "stacked");
  /* one sample sits in the right column; total 50% of 4 levels = 2 dots
   * (heights 1 and 2 are 0x80 and 0x20 there); the inner edge at 25% is
   * height 1, left unlit */
  const bits = dots(line)[0];
  assert.equal(bits & 0x20, 0x20, "height 2 lit");
  assert.equal(bits & 0x80, 0, "height 1 (the edge) unlit");
  assert.equal(bits & 0x10, 0, "height 3 dark");
  assert.deepEqual(stackedTotals([[1, 2], [3, 4]]), [4, 6]);
  assert.deepEqual(stackedTotals([[1, 2], [4]]), [1, 6]);
});

test("chart overlay: the union of two lines, exact width", () => {
  const lines = chart([[10, 90, 10], [90, 10, 90]], 6, 0, 100, 2, "overlay");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(l.length, 6);
  assert.ok(lines.some((l) => l !== "⠀⠀⠀⠀⠀⠀"));
});
