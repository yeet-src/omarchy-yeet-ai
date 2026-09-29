/* The system graph's schema, rendered as compact SDL for the prompt.
 *
 * `yeet graph dump` prints the same schema with every docstring — 66 KB
 * on an Omarchy host — and the isolate cannot shell out for it anyway.
 * Introspection gives the part that matters for writing a query that
 * runs: every field, its arguments, its type, and whether it can be
 * null. The `!` marks are the point: a chart that reads `p.stat.rss`
 * off a process whose stat is null is the failure the schema exists
 * to prevent.
 *
 * The whole schema in one introspection query is hundreds of KB and
 * overruns the response channel, so it is walked breadth-first from
 * the query root — one cheap query for every type's kind, then one
 * per reachable type — which also orders the output root-first.
 * Descriptions are kept, clipped to a line, because they are how the
 * model learns that `sum_exec_runtime` is nanoseconds.
 */

const TYPEREF =
  "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }";

const SCHEMA_QUERY = `{ __schema { queryType { name } types { name kind } } }`;

const typeQuery = (name) =>
  `{ __type(name: ${JSON.stringify(name)}) {
    name
    description
    isOneOf
    fields { name description args { name type { ${TYPEREF} } } type { ${TYPEREF} } }
    enumValues { name }
    inputFields { name description type { ${TYPEREF} } }
  } }`;

const BATCH = 8; /* concurrent per-type queries */
const DESCRIPTION = 90; /* characters of a docstring kept */

const refToString = (ref) => {
  if (!ref) return "Unknown";
  if (ref.kind === "NON_NULL") return `${refToString(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${refToString(ref.ofType)}]`;
  return ref.name ?? "Unknown";
};

const namedType = (ref) => {
  let node = ref;
  while (node && (node.kind === "NON_NULL" || node.kind === "LIST")) node = node.ofType;
  return node?.name ?? null;
};

const comment = (description) => {
  if (!description) return "";
  const text = description.replace(/\s+/g, " ").trim();
  return `  # ${text.length > DESCRIPTION ? `${text.slice(0, DESCRIPTION)}…` : text}`;
};

export const renderType = (type, kind) => {
  if (kind === "ENUM") {
    return `enum ${type.name} { ${(type.enumValues ?? []).map((v) => v.name).join(" | ")} }`;
  }
  const fields = kind === "INPUT_OBJECT" ? (type.inputFields ?? []) : (type.fields ?? []);
  if (!fields.length) return null;

  const body = fields
    .map((field) => {
      const args = (field.args ?? []).map((arg) => `${arg.name}: ${refToString(arg.type)}`).join(", ");
      return `  ${field.name}${args ? `(${args})` : ""}: ${refToString(field.type)}${comment(field.description)}`;
    })
    .join("\n");

  const keyword = kind === "INPUT_OBJECT" ? "input" : "type";
  const oneOf = type.isOneOf ? " @oneOf" : "";
  return `${keyword} ${type.name}${oneOf} {\n${body}\n}`;
};

/* `graph` is a `(gql) => Promise<{ data, errors }>`; the page hands in
 * `yeet.graph.query`, a test a fake. Resolves with `{ sdl, root, fields,
 * types, bytes }`. */
export async function loadSchema(graph) {
  const query = async (source) => {
    const response = await graph(source);
    if (response?.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
    return response?.data ?? response;
  };

  const schema = await query(SCHEMA_QUERY);
  const root = schema.__schema.queryType.name;
  const kinds = new Map(schema.__schema.types.map((t) => [t.name, t.kind]));
  const composite = (name) => ["OBJECT", "INTERFACE", "ENUM", "INPUT_OBJECT"].includes(kinds.get(name));

  const rendered = [];
  const seen = new Set([root]);
  let frontier = [root];
  let fields = [];

  while (frontier.length) {
    const next = [];
    for (let i = 0; i < frontier.length; i += BATCH) {
      const slice = frontier.slice(i, i + BATCH);
      const results = await Promise.all(
        slice.map((name) => query(typeQuery(name)).then((data) => data.__type, () => null)),
      );
      for (const type of results) {
        if (!type) continue;
        if (type.name === root) fields = (type.fields ?? []).map((f) => f.name);
        const sdl = renderType(type, kinds.get(type.name));
        if (sdl) rendered.push(sdl);
        for (const field of [...(type.fields ?? []), ...(type.inputFields ?? [])]) {
          for (const ref of [field.type, ...(field.args ?? []).map((a) => a.type)]) {
            const name = namedType(ref);
            if (name && !name.startsWith("__") && !seen.has(name) && composite(name)) {
              seen.add(name);
              next.push(name);
            }
          }
        }
      }
    }
    frontier = next;
  }

  const sdl = rendered.join("\n\n");
  return { sdl, root, fields, types: rendered.length, bytes: sdl.length };
}
