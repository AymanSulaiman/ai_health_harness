import { expect, test } from "bun:test";
import { TraceEvent } from "./index";
import { schemaPath, schemaText } from "./write-schema";

const event: TraceEvent = {
  run_id: "r1",
  suite_run_id: "s1",
  test_case_id: "v1-001",
  dataset_version: "v1",
  agent_version: "1",
  agent_model: "llama3.1:8b",
  prompt_version: "1",
  judge_model: null,
  judge_prompt_version: null,
  tool_calls: [],
  input_tokens: 812,
  output_tokens: 140,
  latency_ms: 2300,
  raw_output: '{"medications": []}',
  parsed_output: { medications: [] },
  scores: [{ scorer: "allergy_recall", value: 0.5, passed: false, detail: "missed shellfish" }],
  error: null,
  created_at: "2026-10-30T18:00:00.000Z",
};

test("a complete event parses", () => {
  expect(TraceEvent.parse(event)).toEqual(event);
});

test("a failed run parses with nulls and an error", () => {
  const failed = { ...event, raw_output: null, parsed_output: null, input_tokens: null, output_tokens: null, scores: [] };
  expect(TraceEvent.safeParse({ ...failed, error: { stage: "model", message: "timeout" } }).success).toBe(true);
});

test("unknown fields, missing fields and bad values are rejected", () => {
  expect(TraceEvent.safeParse({ ...event, extra: 1 }).success).toBe(false);
  const { run_id, ...missing } = event;
  expect(TraceEvent.safeParse(missing).success).toBe(false);
  // JSON drops undefined keys, so a missing parsed_output must fail here, as it does in Python
  const { parsed_output, ...noOutput } = event;
  expect(TraceEvent.safeParse(noOutput).success).toBe(false);
  expect(TraceEvent.safeParse({ ...event, latency_ms: -1 }).success).toBe(false);
  expect(TraceEvent.safeParse({ ...event, created_at: "yesterday" }).success).toBe(false);
  expect(TraceEvent.safeParse({ ...event, scores: [{ ...event.scores[0], value: 2 }] }).success).toBe(false);
});

test("the checked-in JSON Schema matches the zod schema", async () => {
  // fails after a zod change until `bun run --cwd shared-types schema` is rerun
  expect(await Bun.file(schemaPath).text()).toBe(schemaText());
});
