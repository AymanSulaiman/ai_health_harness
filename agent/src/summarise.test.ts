import { expect, test } from "bun:test";
import { TraceEvent } from "shared-types";
import { ModelError, type Message, type ModelClient, type Reply } from "./model";
import { SYSTEM_PROMPT, summarise } from "./summarise";

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
      return { text: "", input_tokens: 100, output_tokens: 20, latency_ms: 5, ...reply };
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
