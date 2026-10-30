// Example trace events covering each shape a run can take. Printed as JSONL for the
// cross-language contract test (data_processing/tests/test_trace_contract.py):
//   bun shared-types/src/examples.ts
import { TraceEvent } from "./index";

const base = {
  suite_run_id: "suite-1",
  dataset_version: "v1",
  agent_version: "1",
  agent_model: "llama3.1:8b",
  prompt_version: "1",
  judge_model: null,
  judge_prompt_version: null,
  tool_calls: [],
  created_at: "2026-10-30T18:00:00.000Z",
};

export const examples: TraceEvent[] = [
  // passed, deterministic scorers only
  {
    ...base,
    run_id: "run-1",
    test_case_id: "v1-001",
    input_tokens: 812,
    output_tokens: 140,
    latency_ms: 2300,
    raw_output: '{"medications":[{"name":"lisinopril","dose":1}],"allergies":[]}',
    parsed_output: { medications: [{ name: "lisinopril", dose: 1 }], allergies: [] },
    scores: [
      { scorer: "medication_recall", value: 1, passed: true, detail: null },
      { scorer: "allergy_recall", value: 1, passed: true, detail: null },
    ],
    error: null,
  },
  // judged, with a tool call, and a partial miss
  {
    ...base,
    run_id: "run-2",
    test_case_id: "v1-002",
    judge_model: "kimi-k2",
    judge_prompt_version: "1",
    tool_calls: [
      { name: "lookup_medication", input: { rxnorm: "314076" }, output: { name: "lisinopril 10 MG" }, latency_ms: 12 },
      { name: "lookup_medication", input: { rxnorm: "000" }, output: null, latency_ms: 9 },
    ],
    input_tokens: 1204,
    output_tokens: 233,
    latency_ms: 4100,
    raw_output: "Summary: ... (free text, ünïcode, \"quotes\", and a\nnewline)",
    parsed_output: { medications: [], allergies: ["shellfish"], notes: [1, true, null, { deep: ["x"] }] },
    scores: [
      { scorer: "allergy_recall", value: 0.5, passed: false, detail: "missed latex" },
      { scorer: "judge", value: 0.75, passed: true, detail: "Accurate but omits the dose change." },
    ],
    error: null,
  },
  // the model call failed: nothing to parse or score
  {
    ...base,
    run_id: "run-3",
    test_case_id: "v1-003",
    input_tokens: null,
    output_tokens: null,
    latency_ms: 30000,
    raw_output: null,
    parsed_output: null,
    scores: [],
    error: { stage: "model", message: "timed out after 30s" },
  },
  // the model answered but the output did not parse
  {
    ...base,
    run_id: "run-4",
    test_case_id: "v1-004",
    input_tokens: 900,
    output_tokens: 12,
    latency_ms: 1500,
    raw_output: "Sorry, I can't help with that.",
    parsed_output: null,
    scores: [],
    error: { stage: "parse", message: "no JSON object in output" },
  },
];

if (import.meta.main) {
  // parse before writing, as the harness's trace emitter will
  for (const event of examples) console.log(JSON.stringify(TraceEvent.parse(event)));
}
