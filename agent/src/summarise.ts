// The summariser: the system under test. Reads one clinical note and returns a Summary,
// plus everything the trace event needs about the run. It never throws: a failed model
// call or an unusable reply comes back as `error`, so one bad case cannot stop a suite.
import { Summary, type RunError, type ToolCall, type TraceEvent } from "shared-types";
import { lookup, lookupSpec, reference } from "./lookup";
import { ModelError, type Message, type ModelClient, type ToolSpec } from "./model";

/** A tool the agent can call: what the model sees, and what runs when it calls it. */
export type Tool = { spec: ToolSpec; run: (args: Record<string, unknown>) => unknown };

/** One version of the agent. Bump `version` for a code change and `promptVersion` for a prompt change. */
export type Agent = { version: string; promptVersion: string; systemPrompt: string; tools: Tool[] };

const V1_PROMPT = `You are a clinical documentation assistant. Read the clinical note and summarise the patient's current state for a clinician.

- medications: every medication the patient is taking now, with the dose and frequency now in effect. Leave out medications that have been stopped.
- allergies: every allergy or intolerance mentioned anywhere in the note, with its reactions.
- conditions: the patient's active conditions.
- narrative: two or three sentences a clinician could read at a glance.

Use only what the note says. If a dose or frequency is not stated, use null.`;

const lookupMedication: Tool = {
  spec: lookupSpec,
  run: ({ query }) => {
    if (typeof query !== "string") throw new Error("query must be a string");
    return lookup(query, reference());
  },
};

// ponytail: versions live here and are bumped by hand; KAN-17 decides how they are tracked
export const AGENTS: Record<string, Agent> = {
  "1": { version: "1", promptVersion: "1", systemPrompt: V1_PROMPT, tools: [] },
  "2": {
    version: "2",
    promptVersion: "2",
    systemPrompt: `${V1_PROMPT}

Before writing the medication list, call lookup_medication for every current medication as it is written in the note, all in one turn, and use the standard name it returns when one clearly matches (a score of 0.8 or more). Keep the dose and frequency from the note, not from the standard name.`,
    tools: [lookupMedication],
  },
};

export const SYSTEM_PROMPT = V1_PROMPT;

export type AgentRun = Pick<
  TraceEvent,
  "tool_calls" | "input_tokens" | "output_tokens" | "latency_ms" | "raw_output" | "parsed_output" | "error"
>;

const MAX_ATTEMPTS = 2; // the first try plus one retry that is told what was wrong
// gpt-oss:20b asks for one lookup per turn even when told to batch them, so the budget
// covers the longest medication list in the dataset (13). Past it, calls get an error back.
const MAX_TOOL_ROUNDS = 14;
const OUT_OF_TOOLS = { error: "No more tool calls. Reply now with only the JSON summary." };

/** The JSON object in a reply, also when wrapped in code fences or a sentence. */
function parse(text: string): Summary {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the reply");
  return Summary.parse(JSON.parse(text.slice(start, end + 1)));
}

/** Runs one requested tool call. A failure goes back to the model as an error and is recorded with output null. */
function callTool(tools: Tool[], name: string, args: string): { record: ToolCall; content: string } {
  const started = performance.now();
  let input: unknown = args;
  try {
    input = JSON.parse(args);
    const tool = tools.find((t) => t.spec.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    const output = tool.run(input as Record<string, unknown>);
    return { record: { name, input, output, latency_ms: Math.round(performance.now() - started) }, content: JSON.stringify(output) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { record: { name, input, output: null, latency_ms: Math.round(performance.now() - started) }, content: JSON.stringify({ error: message }) };
  }
}

export async function summarise(note: string, client: ModelClient, agent: Agent = AGENTS["1"]!): Promise<AgentRun> {
  const messages: Message[] = [
    { role: "system", content: agent.systemPrompt },
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

  let attempts = 0;
  let toolRounds = 0;
  while (true) {
    let reply;
    try {
      reply = await client.chat(messages, { schema: Summary, ...(agent.tools.length > 0 && { tools: agent.tools.map((t) => t.spec) }) });
    } catch (e) {
      const message = e instanceof ModelError ? e.message : `unexpected: ${String(e)}`;
      return fail({ stage: "model", message });
    }
    // tokens add up across turns; null as soon as the provider leaves one out
    run.input_tokens = reply.input_tokens === null || run.input_tokens === null ? null : run.input_tokens + reply.input_tokens;
    run.output_tokens = reply.output_tokens === null || run.output_tokens === null ? null : run.output_tokens + reply.output_tokens;

    if (reply.tool_calls.length > 0) {
      messages.push({ role: "assistant", content: reply.text, tool_calls: reply.tool_calls });
      if (toolRounds < MAX_TOOL_ROUNDS) {
        toolRounds++;
        for (const call of reply.tool_calls) {
          const { record, content } = callTool(agent.tools, call.name, call.arguments);
          run.tool_calls.push(record);
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
        continue;
      }
      // over budget: refuse the calls, and count the turn as a failed attempt at answering
      for (const call of reply.tool_calls) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(OUT_OF_TOOLS) });
      attempts++;
      run.raw_output = reply.text;
      if (attempts === MAX_ATTEMPTS) return fail({ stage: "parse", message: `after ${attempts} attempts: kept calling tools past ${MAX_TOOL_ROUNDS} rounds` });
      continue;
    }

    attempts++;
    run.raw_output = reply.text;
    try {
      run.parsed_output = parse(reply.text);
      return { ...run, latency_ms: Math.round(performance.now() - started) };
    } catch (e) {
      const problem = e instanceof Error ? e.message : String(e);
      if (attempts === MAX_ATTEMPTS) return fail({ stage: "parse", message: `after ${attempts} attempts: ${problem}` });
      messages.push(
        { role: "assistant", content: reply.text },
        { role: "user", content: `That reply could not be used: ${problem}\nReply again with only the corrected JSON object.` },
      );
    }
  }
}
