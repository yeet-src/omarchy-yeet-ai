/* `:::chart` — the one directive a reply may carry.
 *
 * The model answers in markdown, and the part of the answer that is
 * an instrument rather than a sentence travels as a container
 * directive, the way the notebook's `:::ui` does:
 *
 *   :::chart[label]{live=1000 min=0 max=100 unit=%}
 *   ```js
 *   subscribe(`subscription { … }`, (d) => plot(d.x));
 *   ```
 *   ::
 *
 * This is a parser for exactly that shape, written by hand rather than
 * pulled from remark: the isolate bundles everything it imports, and
 * the whole of remark for one block form is a poor trade. It follows
 * remark-directive's grammar where it matters — `:::name[label]{attrs}`
 * opens, a line of colons closes — and takes the same view of the body
 * as the notebook: a fenced body wins over prose beside it, because
 * splicing ``` into the code is the one outcome nobody wants.
 *
 * A reply is re-parsed as it streams, so an unclosed block is not an
 * error: it comes back `open`, with whatever body has arrived, and the
 * panel shows it as the chart being written.
 */

const OPEN = /^:{3,}([a-zA-Z][\w-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?\s*$/;
const CLOSE = /^:{2,}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*(\w+)?\s*$/;

/* `{live=1000 unit="%" #cpu .wide}` → { live: "1000", unit: "%", id: "cpu", class: "wide" }.
 * Values are strings; the consumer coerces what it needs. A bare word
 * is `true`, so `{fixed}` reads as a flag. */
export function attributes(source) {
  const out = {};
  if (!source) return out;
  const re = /([#.]?[\w-]+)(?:=("([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
  for (const m of source.matchAll(re)) {
    const key = m[1];
    const value = m[3] ?? m[4] ?? m[5];
    if (key.startsWith("#")) out.id = key.slice(1);
    else if (key.startsWith(".")) out.class = key.slice(1);
    else out[key] = value === undefined ? true : value;
  }
  return out;
}

/* The code a body carries. Fenced blocks are joined in order; with no
 * fence the body is taken as it stands. A fence still open when the
 * body ends is taken up to the end, which is what a streaming reply
 * looks like halfway through a block. */
export function scriptOf(lines) {
  const fences = [];
  let fence = null;
  let buf = [];
  for (const line of lines) {
    if (fence === null) {
      const m = FENCE.exec(line);
      if (m && m[1]) {
        fence = m[1];
        buf = [];
      }
      continue;
    }
    if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") {
      fences.push(buf.join("\n"));
      fence = null;
      continue;
    }
    buf.push(line);
  }
  if (fence !== null) fences.push(buf.join("\n"));
  if (fences.length) return fences.join("\n\n");
  return lines.join("\n").trim();
}

/* The reply as a sequence of segments, in order: `{ kind: "text", text }`
 * for prose and `{ kind: "block", name, label, attrs, script, open,
 * start, end }` for a directive. `start`/`end` are character offsets
 * into the source, so a repaired block can be substituted in place. */
export function parse(source) {
  const segments = [];
  const text = String(source ?? "");
  const lines = text.split("\n");

  let offset = 0;
  let prose = [];
  let proseStart = 0;
  let block = null;

  const flushProse = (end) => {
    const text = prose.join("\n").trim();
    if (text) segments.push({ kind: "text", text, start: proseStart, end });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length;

    if (block === null) {
      const m = OPEN.exec(line);
      if (m) {
        flushProse(offset);
        block = { name: m[1], label: (m[2] ?? "").trim(), attrs: attributes(m[3]), body: [], start: offset };
      } else {
        if (!prose.length) proseStart = offset;
        prose.push(line);
      }
    } else if (CLOSE.test(line)) {
      segments.push(finish(block, false, lineEnd));
      block = null;
      proseStart = lineEnd + 1;
    } else {
      block.body.push(line);
    }

    offset = lineEnd + 1;
  }

  if (block !== null) segments.push(finish(block, true, text.length));
  else flushProse(text.length);

  return segments;
}

const finish = (block, open, end) => ({
  kind: "block",
  name: block.name,
  label: block.label,
  attrs: block.attrs,
  script: scriptOf(block.body),
  open,
  start: block.start,
  end,
});

/* A block's identity is its code, so a reply re-parsed while streaming
 * finds the same cell instead of restarting it. An explicit `id`
 * survives an edit. */
export function keyOf(block) {
  if (block.attrs?.id) return `id:${block.attrs.id}`;
  let hash = 0;
  const text = block.script ?? "";
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return `fn:${(hash >>> 0).toString(36)}`;
}

/* Render a block back to source — for substituting a repaired block
 * into the reply it came from. */
export function render(block) {
  const attrs = Object.entries(block.attrs ?? {})
    .filter(([key]) => key !== "class")
    .map(([key, value]) => (value === true ? key : `${key}=${quoteIfNeeded(value)}`))
    .join(" ");
  const head = `:::${block.name}${block.label ? `[${block.label}]` : ""}${attrs ? `{${attrs}}` : ""}`;
  return `${head}\n\`\`\`js\n${block.script}\n\`\`\`\n::`;
}

const quoteIfNeeded = (value) => (/[\s"'{}]/.test(String(value)) ? JSON.stringify(String(value)) : String(value));
