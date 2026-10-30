// LLM-as-judge: grades what string matching cannot, such as whether the narrative is faithful
// and useful, and whether anything clinically important was left out (conditions included,
// where "HTN" vs "Essential hypertension" defeats the deterministic scorers).
import { z } from "zod";
import type { ModelClient } from "agent";
import type { Score, Summary } from "shared-types";
import type { GroundTruth } from "./ground-truth";
import { scorable } from "./scorers";

// Bump on any change to JUDGE_PROMPT or Verdict; it is written into every trace event, so a
// judge change can be told apart from an agent change.
export const JUDGE_PROMPT_VERSION = "1";

export const JUDGE_PROMPT = `You grade a summary of a clinical note written by an AI assistant. You get the note, the patient's record (the correct current medications, allergies and active conditions), and the summary.

Grade each from 1 (bad) to 5 (excellent), with a one or two sentence rationale naming specifics:

- faithfulness: everything in the summary is supported by the note. A stopped medication listed as current, a superseded dose, or anything invented lowers it.
- usefulness: a clinician could act on the summary at a glance; the narrative is clear and accurate.
- omissions: 5 means nothing clinically important is missing. Missing allergies, current medications or major active conditions lower it. Abbreviations (HTN) and plain wording (high blood pressure) count as present.

The summary is meant to hold only the patient's current state: stopped medications are left out on purpose, and the record shows what should be there. Social history and the follow-up plan are not required.

Judge the summary against the note and the record, not against your own preferences for style.`;

const Grade = z.strictObject({ score: z.int().min(1).max(5), rationale: z.string() });
export const Verdict = z.strictObject({ faithfulness: Grade, usefulness: Grade, omissions: Grade });
export type Verdict = z.infer<typeof Verdict>;

export const PASS_MARK = 4; // a grade of 4 or 5 passes

const MAX_ATTEMPTS = 2;

// ponytail: reasoning off. kimi-k2.6 thinks for over a minute on this prompt, and Ollama Cloud
// drops a non-streamed request at 60 s (checked 2026-10-30); off, it answers in about 12 s.
// Stream the reply if a reasoning judge is ever wanted.

/** Three judge scores (judge_faithfulness, judge_usefulness, judge_omissions), value scaled to 0-1. Throws if the judge fails twice. */
export async function judge(note: string, truth: GroundTruth, summary: Summary, client: ModelClient): Promise<Score[]> {
  const record = {
    medications: truth.medications.map((m) => m.name),
    allergies: scorable(truth).map((a) => a.substance), // without "Allergic disposition", which names no substance
    conditions: truth.conditions.map((c) => c.name),
  };
  const content = `NOTE:\n${note}\n\nRECORD:\n${JSON.stringify(record, null, 2)}\n\nSUMMARY:\n${JSON.stringify(summary, null, 2)}`;
  let problem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await client.chat([{ role: "system", content: JUDGE_PROMPT }, { role: "user", content }], { schema: Verdict, reasoning_effort: "none" });
    try {
      const text = reply.text;
      const verdict = Verdict.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
      return (["faithfulness", "usefulness", "omissions"] as const).map((k) => ({
        scorer: `judge_${k}`,
        value: (verdict[k].score - 1) / 4,
        passed: verdict[k].score >= PASS_MARK,
        detail: `${verdict[k].score}/5: ${verdict[k].rationale}`,
      }));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`judge reply unusable after ${MAX_ATTEMPTS} attempts: ${problem}`);
}
