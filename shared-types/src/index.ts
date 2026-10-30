// The trace event: one line per agent run on one test case, written by the TypeScript
// harness and read by the Python pipeline. schemas/trace_event.schema.json is generated
// from this file (bun run --cwd shared-types schema); edit here, never there.
import { z } from "zod";

const id = z.string().min(1);
const count = z.int().nonnegative();

export const ToolCall = z.strictObject({
  name: id,
  input: z.unknown().describe("Arguments the agent passed, as JSON"),
  output: z.unknown().describe("What the tool returned, as JSON; null if it failed"),
  latency_ms: count,
});

export const Score = z.strictObject({
  scorer: id.describe("e.g. medication_recall, allergy_recall, dose_match, judge"),
  value: z.number().min(0).max(1),
  passed: z.boolean(),
  detail: z.string().nullable().describe("Why, in a sentence: what was missed, or the judge's reasoning"),
});

// What the summariser returns for one note. Scorers compare it with the case's ground truth.
export const Summary = z.strictObject({
  narrative: z.string().describe("A few sentences a clinician could read at a glance"),
  medications: z
    .array(
      z.strictObject({
        name: z.string().describe("Drug with strength and form, as written in the note"),
        dose: z.string().nullable().describe("Amount per dose now in effect, e.g. '1 tablet'; null if not stated"),
        frequency: z.string().nullable().describe("e.g. 'twice daily', 'as needed'; null if not stated"),
      }),
    )
    .describe("Medications the patient currently takes"),
  allergies: z.array(
    z.strictObject({
      substance: z.string(),
      reactions: z.array(z.string()).describe("Empty if none are stated"),
    }),
  ),
  conditions: z.array(z.string()).describe("Active conditions"),
});

export const RunError = z.strictObject({
  stage: z.enum(["model", "parse", "score"]).describe("Where the run failed"),
  message: z.string(),
});

export const TraceEvent = z
  .strictObject({
    run_id: id.describe("Unique per agent run on one test case"),
    suite_run_id: id.describe("Shared by every run in one pass over the dataset"),
    test_case_id: id.describe("case_id in datasets/notes_<version>.jsonl, e.g. v1-001"),
    dataset_version: id,

    agent_version: id,
    agent_model: id.describe("e.g. an Ollama model tag"),
    prompt_version: id,

    judge_model: id.nullable().describe("null when no LLM judge scored this run"),
    judge_prompt_version: id.nullable(),

    tool_calls: z.array(ToolCall),
    input_tokens: count.nullable().describe("null when the model call failed"),
    output_tokens: count.nullable(),
    latency_ms: count.describe("Wall time of the whole agent run"),

    raw_output: z.string().nullable().describe("The model's text as returned; null when the model call failed"),
    parsed_output: Summary.nullable().describe("raw_output parsed into the summary; null when parsing failed"),
    scores: z.array(Score),
    error: RunError.nullable(),

    created_at: z.iso.datetime({ offset: true }),
  })
  .meta({
    title: "TraceEvent",
    description: "One agent run on one test case. One event per line in the trace files.",
  });

export type Summary = z.infer<typeof Summary>;
export type ToolCall = z.infer<typeof ToolCall>;
export type Score = z.infer<typeof Score>;
export type RunError = z.infer<typeof RunError>;
export type TraceEvent = z.infer<typeof TraceEvent>;

export const traceEventJsonSchema = () => z.toJSONSchema(TraceEvent, { target: "draft-2020-12" });
