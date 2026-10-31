import { expect, test } from "bun:test";
import type { Message, ModelClient } from "agent";
import { Score } from "shared-types";
import type { GroundTruth } from "./ground-truth";
import { judge } from "./judge";

const truth: GroundTruth = {
  patient_id: "p", as_of: "2026-01-01",
  medications: [{ name: "lisinopril 10 MG Oral Tablet", rxnorm: "x", as_needed: false, dose: 1, timing: null }],
  allergies: [], conditions: [{ name: "Essential hypertension (disorder)", system: "snomed", code: "1", onset: null }],
};
const summary = { narrative: "Hypertensive, on lisinopril.", medications: [{ name: "lisinopril", dose: "1 tablet", frequency: null }], allergies: [], conditions: ["HTN"] };
const grade = (score: number, rationale = "ok") => ({ score, rationale });
const verdict = JSON.stringify({ faithfulness: grade(5, "all supported"), usefulness: grade(4), omissions: grade(2, "missed CKD") });

function scripted(...replies: string[]) {
  const sent: Message[][] = [];
  const client: ModelClient = {
    spec: "fake/judge",
    async chat(messages) {
      sent.push(messages);
      return { text: replies.shift()!, input_tokens: 1, output_tokens: 1, latency_ms: 1, tool_calls: [] };
    },
  };
  return { client, sent };
}

test("three scores, scaled to 0-1, passing at 4 or 5, rationale kept", async () => {
  const { client, sent } = scripted(`Here you go:\n${verdict}`);
  const scores = await judge("the note", truth, summary, client);
  expect(scores.map((s) => Score.parse(s))).toEqual([
    { scorer: "judge_faithfulness", value: 1, passed: true, detail: "5/5: all supported" },
    { scorer: "judge_usefulness", value: 0.75, passed: true, detail: "4/5: ok" },
    { scorer: "judge_omissions", value: 0.25, passed: false, detail: "2/5: missed CKD" },
  ]);
  const prompt = sent[0]!.at(-1)!.content;
  for (const part of ["the note", "Essential hypertension", '"HTN"']) expect(prompt).toContain(part);
});

test("an unusable reply is retried once, then throws", async () => {
  expect(await judge("n", truth, summary, scripted("no json", verdict).client)).toHaveLength(3);
  const bad = JSON.stringify({ faithfulness: grade(6), usefulness: grade(4), omissions: grade(4) });
  await expect(judge("n", truth, summary, scripted("no json", bad).client)).rejects.toThrow("judge reply unusable after 2 attempts");
});
