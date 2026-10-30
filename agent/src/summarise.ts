// The summariser: the system under test. Reads one clinical note and returns a Summary,
// plus everything the trace event needs about the run. It never throws: a failed model
// call or an unusable reply comes back as `error`, so one bad case cannot stop a suite.
import { Summary, type RunError, type TraceEvent } from "shared-types";
import { ModelError, type Message, type ModelClient } from "./model";

export const PROMPT_VERSION = "1";

export const SYSTEM_PROMPT = `You are a clinical documentation assistant. Read the clinical note and summarise the patient's current state for a clinician.

- medications: every medication the patient is taking now, with the dose and frequency now in effect. Leave out medications that have been stopped.
- allergies: every allergy or intolerance mentioned anywhere in the note, with its reactions.
- conditions: the patient's active conditions.
- narrative: two or three sentences a clinician could read at a glance.

Use only what the note says. If a dose or frequency is not stated, use null.`;

export type AgentRun = Pick<
  TraceEvent,
  "tool_calls" | "input_tokens" | "output_tokens" | "latency_ms" | "raw_output" | "parsed_output" | "error"
>;

const MAX_ATTEMPTS = 2; // the first try plus one retry that is told what was wrong

/** The JSON object in a reply, also when wrapped in code fences or a sentence. */
function parse(text: string): Summary {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the reply");
  return Summary.parse(JSON.parse(text.slice(start, end + 1)));
}

export async function summarise(note: string, client: ModelClient): Promise<AgentRun> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: note },
  ];
  const run: AgentRun = {
    tool_calls: [],
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    raw_output: null,
    parsed_output: null,
    error: null,
  };
  const started = performance.now();
  const fail = (error: RunError): AgentRun => ({ ...run, latency_ms: Math.round(performance.now() - started), error });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let reply;
    try {
      reply = await client.chat(messages, { schema: Summary });
    } catch (e) {
      const message = e instanceof ModelError ? e.message : `unexpected: ${String(e)}`;
      return fail({ stage: "model", message });
    }
    // tokens add up across attempts; null as soon as the provider leaves one out
    run.input_tokens = reply.input_tokens === null || run.input_tokens === null ? null : run.input_tokens + reply.input_tokens;
    run.output_tokens = reply.output_tokens === null || run.output_tokens === null ? null : run.output_tokens + reply.output_tokens;
    run.raw_output = reply.text;
    try {
      run.parsed_output = parse(reply.text);
      return { ...run, latency_ms: Math.round(performance.now() - started) };
    } catch (e) {
      const problem = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_ATTEMPTS) return fail({ stage: "parse", message: `after ${attempt} attempts: ${problem}` });
      messages.push(
        { role: "assistant", content: reply.text },
        { role: "user", content: `That reply could not be used: ${problem}\nReply again with only the corrected JSON object.` },
      );
    }
  }
  throw new Error("unreachable");
}
