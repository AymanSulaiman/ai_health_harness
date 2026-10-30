// Scorers against every real case in datasets/notes_v1.jsonl: a summary that restates the
// ground truth must score full marks, and dropping any one item must be caught. Exercises
// the matcher on every real drug and allergen name. Skipped when the dataset is not built (CI).
import { expect, test } from "bun:test";
import type { Summary } from "shared-types";
import type { GroundTruth } from "./ground-truth";
import { scoreRun } from "./scorers";

const file = Bun.file(`${import.meta.dir}/../../datasets/notes_v1.jsonl`);
const cases: { case_id: string; ground_truth: GroundTruth }[] = (await file.exists())
  ? (await file.text()).trim().split("\n").map((l) => JSON.parse(l))
  : [];

const WORDS: Record<number, string> = { 1: "once daily", 2: "twice daily", 3: "three times daily", 4: "four times daily" };
const UNITS: Record<string, string> = { h: "hours", d: "days", wk: "weeks" };

function restate(truth: GroundTruth): Summary {
  return {
    narrative: "",
    medications: truth.medications.map((m) => {
      const t = m.timing;
      const frequency = m.as_needed ? "as needed"
        : !t ? null
        : t.period === 1 && t.period_unit === "d" ? WORDS[t.frequency]!
        : `every ${t.period} ${UNITS[t.period_unit]}`;
      return { name: m.name, dose: m.dose === null ? null : `${m.dose} tablet`, frequency };
    }),
    allergies: truth.allergies.map((a) => ({ substance: a.substance.replace(/\s*\([^)]*\)$/, ""), reactions: [] })),
    conditions: truth.conditions.map((c) => c.name),
  };
}

test.skipIf(cases.length === 0)("restating the ground truth scores full marks on every case", () => {
  const failures = cases.flatMap((c) =>
    scoreRun(restate(c.ground_truth), c.ground_truth)
      .filter((s) => !s.passed || s.value !== 1)
      .map((s) => `${c.case_id} ${s.scorer}: ${s.detail}`),
  );
  expect(failures).toEqual([]);
});

test.skipIf(cases.length === 0)("dropping any one medication or allergy is caught", () => {
  let checked = 0;
  for (const c of cases) {
    const full = restate(c.ground_truth);
    full.medications.forEach((_, i) => {
      const summary = { ...full, medications: full.medications.toSpliced(i, 1) };
      expect(scoreRun(summary, c.ground_truth).find((s) => s.scorer === "medication_recall")!.passed).toBe(false);
      checked++;
    });
    full.allergies.forEach((a, i) => {
      if (a.substance === "Allergic disposition") return; // never expected
      const summary = { ...full, allergies: full.allergies.toSpliced(i, 1) };
      expect(scoreRun(summary, c.ground_truth).find((s) => s.scorer === "allergy_recall")!.passed).toBe(false);
      checked++;
    });
  }
  expect(checked).toBeGreaterThan(300);
});
