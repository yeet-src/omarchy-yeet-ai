/* The turn loop, with rendering left to the caller: every step is
 * reported through callbacks so the panel can paint text deltas as they
 * land and show each tool call as the model makes it.
 *
 * `stream` and `runTool` are handed in — the page gives it `yeet:ai`'s
 * — so the loop itself runs under Node against a scripted stream.
 *
 * One conversation, kept small: across turns only the questions and
 * the final answers are remembered, so a follow-up ("and swap?") lands
 * in context, while the schema dumps and query results a turn read on
 * the way stay inside that turn.
 */

const MAX_TURNS = 8;
const MAX_HISTORY = 12; /* messages kept across turns */

/* Six chart blocks run to four or five thousand tokens; a cap below that
 * cuts the last block mid-body and it never parses. */
export function createAgent({ model, system, tools, stream, runTool, on = {}, maxTokens = 8192 }) {
  const history = [];
  /* Either may be a value or a function of no arguments, read at the
   * start of every turn: the panel switches models between questions,
   * and the schema the prompt carries arrives after the page is up. */
  const read = (v) => (typeof v === "function" ? v() : v);
  let live = null;
  let busy = false;

  const reporter = (hooks) => (name, ...args) => {
    try {
      hooks[name]?.(...args);
    } catch (error) {
      console.warn(`askai: on.${name} threw: ${error?.message ?? error}`);
    }
  };

  /* Cancelling is best-effort: the upstream generation may already have
   * finished. Dropping the handle first keeps a late terminal frame
   * from reopening a turn the user abandoned. */
  const cancel = async () => {
    const chat = live;
    live = null;
    try {
      await chat?.cancel();
    } catch {
      /* already ended */
    }
  };

  /* One question, answered. Resolves with `{ text, cancelled, error }`
   * once the turn has settled, whichever way. `context` is a system
   * addendum for this turn only — the panel's width, say. Per-ask
   * hooks override the agent's own, and `remember: false` keeps a
   * turn (a repair, say) out of the conversation. */
  const ask = async (question, { context = "", on: overrides = {}, remember = true } = {}) => {
    if (busy) return { text: "", cancelled: false, error: "busy" };
    busy = true;
    const report = reporter({ ...on, ...overrides });

    const messages = [...history, { role: "user", content: question }];
    let answer = "";
    let outcome = { text: "", cancelled: false, error: null };

    try {
      for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const last = turn === MAX_TURNS;
        const base = read(system);
        const chat = stream({
          model: read(model),
          system: context ? `${base}\n\n${context}` : base,
          messages,
          /* Withholding the tools on the last turn forces an answer out
           * of what it has rather than one more unread query. */
          tools: last ? [] : tools,
          max_tokens: maxTokens,
        });
        live = chat;

        for await (const event of chat) {
          if (event.type === "text") {
            const delta = event.delta ?? "";
            answer += delta;
            report("text", delta, answer);
          }
          if (event.type === "usage") report("usage", event);
        }

        const result = await chat.result;
        const cancelled = live === null;
        live = null;

        if (result.text) messages.push({ role: "assistant", content: result.text });

        const calls = result.tool_calls ?? [];
        if (cancelled || calls.length === 0 || last) {
          outcome = { text: answer, cancelled, error: null };
          break;
        }

        for (const call of calls) {
          report("tool", call);
          let result;
          try {
            result = await runTool(tools, call);
          } catch (error) {
            result = { tool_call_id: call.id, name: call.name, result: { error: String(error?.message ?? error) } };
          }
          report("toolResult", call, result.result);
          messages.push({ role: "user", content: JSON.stringify(result) });
        }
        /* The text so far was the model thinking aloud between tools;
         * the answer is what comes after the last call. */
        if (answer) {
          answer = "";
          report("text", "", "");
        }
      }
    } catch (error) {
      live = null;
      const message = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
      outcome = { text: answer, cancelled: false, error: message };
      report("error", message);
    }

    if (remember && !outcome.error && !outcome.cancelled) {
      history.push({ role: "user", content: question });
      if (outcome.text) history.push({ role: "assistant", content: outcome.text });
      while (history.length > MAX_HISTORY) history.shift();
    }
    busy = false;
    report("answer", outcome.text, outcome);
    return outcome;
  };

  return { ask, cancel, clear: () => history.splice(0), get busy() { return busy; } };
}
