/* The two tools the model drives before it writes a chart: read the
 * schema, then query it. Both stay in the isolate — the platform sees
 * the name, description and JSON Schema, never the host data they
 * return.
 *
 * `graph` is passed in rather than read off the global so the tools
 * can be exercised under Node with a fake; the page hands them the
 * real `yeet.graph.query`.
 */

const RESULT_LIMIT = 12000;
const LIST_LIMIT = 40;
const DESCRIPTION_LIMIT = 100;

/* Introspection has no fragments here, so the type ref is inlined to
 * the four levels a `[Thing!]!` style chain can reach. */
const REF = "{ kind name ofType { kind name ofType { kind name ofType { kind name } } } }";
const FIELDS = `fields { name description args { name type ${REF} } type ${REF} }`;

export function createTools(graph) {
  /* A GraphQL error is a result, not an exception: the text is what
   * lets the model fix its own query and try again. */
  const once = async (source) => {
    const response = await graph(source);
    if (response?.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
    return response?.data ?? response;
  };

  const queryRoot = async () => {
    const data = await once(`{ __schema { queryType { ${FIELDS} } } }`);
    return renderType("type Query", data.__schema.queryType.fields);
  };

  const describeType = async (name) => {
    const data = await once(`{ __type(name: ${JSON.stringify(name)}) {
      kind description ${FIELDS}
      inputFields { name description type ${REF} }
      enumValues { name }
    } }`);
    const type = data.__type;
    if (type === null) return `Unknown type "${name}".`;
    if (type.kind === "ENUM") return `enum ${name} { ${type.enumValues.map((v) => v.name).join(" ")} }`;
    const fields = type.fields ?? type.inputFields;
    if (!fields) return `${type.kind.toLowerCase()} ${name}${comment(type.description)}`;
    return renderType(`${type.kind === "INPUT_OBJECT" ? "input" : "type"} ${name}`, fields);
  };

  const graphSchema = {
    name: "graph_schema",
    description:
      "Read the sys_graph GraphQL schema. Call with no argument for the Query root fields, "
      + "or with a type name (comma-separated for several) to list that type's fields. "
      + "Every Query field also exists as a subscription with the same name and arguments.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: 'Type name, or a comma list, e.g. "Process,Fd". Omit for the Query root.',
        },
      },
    },
    /* The Query root rides along with every answer: a model that drills
     * straight into `Process` otherwise never learns `proc(pid:)` exists. */
    handler: async ({ type } = {}) => {
      const names = String(type ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      const described = await Promise.all([queryRoot(), ...names.map(describeType)]);
      return { schema: described.join("\n\n") };
    },
  };

  const graphQuery = {
    name: "graph_query",
    description:
      "Run a one-shot GraphQL query against sys_graph, the live view of this host, to check a "
      + "shape or find a pid before writing a chart. Select only the fields you need — "
      + "`procs` alone is hundreds of processes.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "GraphQL query, e.g. { meminfo { mem_available } }" },
      },
      required: ["query"],
    },
    handler: async ({ query } = {}) => {
      try {
        return clamp(await once(String(query ?? "")));
      } catch (error) {
        return { error: error.message };
      }
    },
  };

  return { tools: [graphSchema, graphQuery], queryRoot, describeType, once };
}

/* Cutting a JSON string mid-token leaves the model something it cannot
 * parse; shorten the long lists instead and say what was dropped. */
export function clamp(data) {
  if (JSON.stringify(data).length <= RESULT_LIMIT) return data;
  const clamped = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!Array.isArray(value) || value.length <= LIST_LIMIT) {
      clamped[key] = value;
      continue;
    }
    clamped[key] = value.slice(0, LIST_LIMIT);
    clamped[`${key}_note`] =
      `Showing ${LIST_LIMIT} of ${value.length}. Select fewer fields to see them all, `
      + "then drill into one item by id.";
  }
  return clamped;
}

function renderType(header, fields) {
  const body = fields
    .map((f) => `  ${f.name}${args(f)}: ${typeName(f.type)}${comment(f.description)}`)
    .join("\n");
  return `${header} {\n${body}\n}`;
}

function args(field) {
  if (!field.args?.length) return "";
  return `(${field.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(", ")})`;
}

function typeName(ref) {
  if (!ref) return "Unknown";
  if (ref.kind === "NON_NULL") return `${typeName(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${typeName(ref.ofType)}]`;
  return ref.name ?? "Unknown";
}

function comment(description) {
  if (!description) return "";
  const text = description.replace(/\s+/g, " ").trim();
  return `  # ${text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text}`;
}
