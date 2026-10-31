import { expect, test } from "bun:test";
import { TraceEvent } from "shared-types";
import { ModelError, type ChatOptions, type Message, type ModelClient, type Reply } from "./model";
import { SYSTEM_PROMPT, summarise, type Agent } from "./summarise";

const GOOD = {
  narrative: "Stable.",
  medications: [{ name: "lisinopril 10 MG Oral Tablet", dose: "1 tablet", frequency: "daily" }],
  allergies: [{ substance: "shellfish", reactions: ["anaphylaxis"] }],
  conditions: ["Hypertension"],
};

/** A client that plays back scripted replies (or throws), and records what it was sent. */
function scripted(...replies: (string | Error | Partial<Reply>)[]) {
  const sent: Message[][] = [];
  const client: ModelClient = {
    spec: "fake/model",
    async chat(messages) {
      sent.push(structuredClone(messages));
      const next = replies.shift();
      if (next instanceof Error) throw next;
      const reply = typeof next === "string" ? { text: next } : next;
      return { text: "", input_tokens: 100, output_tokens: 20, latency_ms: 5, tool_calls: [], ...reply };
    },
  };
  return { client, sent };
}

// every run, whatever happened, must fit the trace event it will be written into
function asTrace(run: object) {
  return TraceEvent.parse({
    run_id: "r", suite_run_id: "s", test_case_id: "v1-001", dataset_version: "v1", agent_version: "1",
    agent_model: "fake/model", prompt_version: "1", judge_model: null, judge_prompt_version: null,
    scores: [], created_at: "2026-10-30T18:00:00Z", ...run,
  });
}

test("a valid reply is parsed on the first try", async () => {
  const { client, sent } = scripted(JSON.stringify(GOOD));
  const run = await summarise("the note", client);
  expect(run).toMatchObject({ parsed_output: GOOD, error: null, input_tokens: 100, output_tokens: 20 });
  expect(sent).toEqual([[{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "the note" }]]);
  asTrace(run);
});

test("JSON wrapped in code fences or a sentence is still found", async () => {
  const { client } = scripted("Here you go:\n```json\n" + JSON.stringify(GOOD) + "\n```");
  expect((await summarise("n", client)).parsed_output).toEqual(GOOD);
});

test("a bad reply is retried once, told what was wrong, and tokens add up", async () => {
  const bad = JSON.stringify({ ...GOOD, conditions: "Hypertension" });
  const { client, sent } = scripted(bad, JSON.stringify(GOOD));
  const run = await summarise("n", client);
  expect(run).toMatchObject({ parsed_output: GOOD, error: null, input_tokens: 200, output_tokens: 40 });
  expect(run.raw_output).toBe(JSON.stringify(GOOD));
  const retry = sent[1]!;
  expect(retry.at(-2)).toEqual({ role: "assistant", content: bad });
  expect(retry.at(-1)!.content).toContain("conditions");
  asTrace(run);
});

test("two bad replies give a parse error with the last reply kept, not an exception", async () => {
  const { client, sent } = scripted("Sorry, I can't help.", "Still prose.");
  const run = await summarise("n", client);
  expect(sent).toHaveLength(2);
  expect(run.parsed_output).toBeNull();
  expect(run.raw_output).toBe("Still prose.");
  expect(run.error).toEqual({ stage: "parse", message: "after 2 attempts: no JSON object in the reply" });
  asTrace(run);
});

test("malformed JSON is a parse error too", async () => {
  const { client } = scripted('{"narrative": "cut off', '{"narrative": "cut off');
  expect((await summarise("n", client)).error?.stage).toBe("parse");
});

test("a failed model call is a model error with nothing parsed", async () => {
  const { client } = scripted(new ModelError("fake/model: HTTP 503: overloaded", 503));
  const run = await summarise("n", client);
  expect(run).toMatchObject({ raw_output: null, parsed_output: null, error: { stage: "model", message: "fake/model: HTTP 503: overloaded" } });
  asTrace(run);
});

test("a model failure on the retry keeps the first reply's tokens", async () => {
  const { client } = scripted("prose", new ModelError("timed out"));
  const run = await summarise("n", client);
  expect(run).toMatchObject({ raw_output: "prose", input_tokens: 100, error: { stage: "model" } });
});

test("token counts are null when the provider leaves them out", async () => {
  const { client } = scripted({ text: JSON.stringify(GOOD), input_tokens: null, output_tokens: null });
  expect(await summarise("n", client)).toMatchObject({ input_tokens: null, output_tokens: null });
});

const echo: Agent = {
  version: "t",
  promptVersion: "t",
  systemPrompt: "use the tool",
  tools: [{ spec: { name: "echo", description: "echo", parameters: {} }, run: ({ q }) => ({ heard: q }) }],
};
const call = (id: string, name: string, args: string) => ({ text: "", tool_calls: [{ id, name, arguments: args }] });

test("tool calls run, are recorded, and their results go back to the model", async () => {
  const { client, sent } = scripted(call("c1", "echo", '{"q":"lisnpr"}'), JSON.stringify(GOOD));
  const run = await summarise("the note", client, echo);
  expect(run.parsed_output).toEqual(GOOD);
  expect(run.tool_calls).toEqual([{ name: "echo", input: { q: "lisnpr" }, output: { heard: "lisnpr" }, latency_ms: expect.any(Number) }]);
  expect(sent[1]!.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"heard":"lisnpr"}' });
  expect(run.input_tokens).toBe(200); // both turns count
  asTrace(run);
});

test("a bad tool call is recorded with output null and the model is told why", async () => {
  const { client, sent } = scripted(call("c1", "nope", "{}"), call("c2", "echo", "not json"), JSON.stringify(GOOD));
  const run = await summarise("the note", client, echo);
  expect(run.tool_calls.map((t) => t.output)).toEqual([null, null]);
  expect(sent[1]!.at(-1)!.content).toContain("no tool named nope");
  expect(run.parsed_output).toEqual(GOOD);
  asTrace(run);
});

test("past the tool budget, calls are refused with an error and count as failed attempts", async () => {
  const rounds = 14;
  const { client, sent } = scripted(...Array.from({ length: rounds + 1 }, (_, i) => call(`c${i}`, "echo", "{}")), JSON.stringify(GOOD));
  const run = await summarise("the note", client, echo);
  expect(run.tool_calls).toHaveLength(rounds); // the extra call was not run
  expect(sent.at(-1)!.at(-1)!.content).toContain("No more tool calls");
  expect(run.parsed_output).toEqual(GOOD); // one refused turn, then a good answer

  const stuck = scripted(...Array.from({ length: rounds + 2 }, (_, i) => call(`c${i}`, "echo", "{}")));
  const failed = await summarise("the note", stuck.client, echo);
  expect(failed.error).toEqual({ stage: "parse", message: `after 2 attempts: kept calling tools past ${rounds} rounds` });
  asTrace(failed);
});
