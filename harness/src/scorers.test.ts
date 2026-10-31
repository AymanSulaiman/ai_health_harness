import { describe, expect, test } from "bun:test";
import { Score, type Summary } from "shared-types";
import type { GroundTruth } from "./ground-truth";
import {
  alignment, allergyRecall, doseAmount, doseMatch, doseRight, frequencyRate, hallucinations, match,
  medicationPrecision, medicationRecall, schemaValid, scoreRun, similarity,
} from "./scorers";

const med = (name: string, dose: number | null = null, timing: [number, number, string] | null = null, as_needed: boolean | null = null) => ({
  name, rxnorm: "x", dose, as_needed: as_needed ?? (dose === null ? null : false),
  timing: timing && { frequency: timing[0], period: timing[1], period_unit: timing[2] },
});
const allergy = (substance: string, snomed = "x") => ({ substance, snomed, category: null, type: null, reactions: [] });

const TRUTH: GroundTruth = {
  patient_id: "p", as_of: "2026-01-01",
  medications: [
    med("lisinopril 10 MG Oral Tablet", 1, [1, 1, "d"]),
    med("NDA020983 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler [Ventolin]", null, null, true),
    med("{7 (ethinyl estradiol 0.01 MG Oral Tablet) / 84 (ethinyl estradiol 0.03 MG / levonorgestrel 0.15 MG Oral Tablet) } Pack [Seasonique]"),
  ],
  allergies: [
    allergy("Allergic disposition (finding)", "609328004"),
    allergy("Shellfish (substance)"),
    allergy("Tree pollen (substance)"),
    allergy("House dust mite (organism)"),
  ],
  conditions: [],
};
const m = (name: string, dose: string | null = null, frequency: string | null = null) => ({ name, dose, frequency });
const a = (substance: string) => ({ substance, reactions: [] });
const PERFECT: Summary = {
  narrative: "",
  medications: [
    m("Lisinopril 10mg", "1 tablet", "once daily"),
    m("Ventolin inhaler", null, "PRN"),
    m("Seasonique"),
  ],
  allergies: [a("shellfish"), a("tree pollen"), a("dust mites")],
  conditions: [],
};
const only = (s: Partial<Summary>): Summary => ({ ...PERFECT, ...s });

describe("matching names", () => {
  test.each([
    ["lisinopril", "lisinopril 10 MG Oral Tablet"],
    ["Lisinopril 10mg tab", "lisinopril 10 MG Oral Tablet"],
    ["diphenhydramine HCl 25 mg", "diphenhydrAMINE Hydrochloride 25 MG Oral Tablet"],
    ["metoprolol ER 100 mg", "24 HR metoprolol succinate 100 MG Extended Release Oral Tablet"],
    ["Seasonique", "{7 (ethinyl estradiol 0.01 MG Oral Tablet) / 84 (ethinyl estradiol 0.03 MG / levonorgestrel 0.15 MG Oral Tablet) } Pack [Seasonique]"],
    ["Humulin 70/30", "insulin isophane, human 70 UNT/ML / insulin, regular, human 30 UNT/ML Injectable Suspension [Humulin]"],
    ["dust mites", "House dust mite (organism)"],
    ["eggs", "Eggs (edible) (substance)"],
  ])("%p matches %p", (output, truth) => {
    expect(similarity(output, truth)).toBeGreaterThan(0.5);
  });

  test.each([
    ["lisinopril 20 mg", "lisinopril 10 MG Oral Tablet"], // wrong strength
    ["ibuprofen", "Naproxen sodium 220 MG Oral Tablet"],
    ["tree pollen", "Grass pollen (substance)"],
    ["oral tablet", "lisinopril 10 MG Oral Tablet"], // packaging words alone name nothing
  ])("%p does not match %p", (output, truth) => {
    expect(similarity(output, truth)).toBeLessThanOrEqual(0.5);
  });

  test("pairs are one-to-one, best first", () => {
    const truths = ["Tree pollen (substance)", "Grass pollen (substance)"];
    expect(match(["grass pollen", "tree pollen"], truths)).toEqual([[0, 1], [1, 0]]);
    expect(match(["pollen", "pollen"], truths)).toHaveLength(2); // vague, but each output used once
    expect(match(["lisinopril", "lisinopril"], ["lisinopril 10 MG Oral Tablet"])).toHaveLength(1);
  });
});

describe("reading doses and frequencies", () => {
  test.each([["1 tablet", 1], ["2 puffs", 2], ["10 MG", 10], ["0.3 ML", 0.3], ["one tablet", 1], ["tablet", null]])(
    "dose %p reads as %p", (dose, amount) => expect(doseAmount(dose)).toBe(amount),
  );

  test.each([
    ["once daily", 1], ["QD", 1], ["daily", 1], ["every day", 1], ["at bedtime", 1],
    ["twice daily", 2], ["BID", 2], ["three times daily", 3], ["TID", 3], ["QID", 4], ["four times daily", 4],
    ["q6h", 4], ["every 6 hours", 4], ["q4h", 6], ["every 3 days", 1 / 3], ["every other day", 0.5],
    ["as needed", "prn"], ["PRN", "prn"], ["2 times a day", 2], ["sometimes", null],
  ])("frequency %p reads as %p", (f, rate) => expect(frequencyRate(f as string)).toBe(rate as number | "prn" | null));

  const lisinopril = med("lisinopril 10 MG Oral Tablet", 1, [1, 1, "d"]);
  test.each([["1 tablet", true], ["10 MG", true], ["10 mg", true], ["2 tablets", false], ["20 MG", false], [null, false], ["a tablet", false]])(
    "dose %p for one 10 MG tablet is right: %p", (dose, right) => expect(doseRight(dose, lisinopril)).toBe(right),
  );
});

describe("scorers", () => {
  test("a perfect summary passes every scorer with value 1", () => {
    for (const s of scoreRun(PERFECT, TRUTH)) {
      expect(Score.parse(s)).toEqual(s);
      expect(s).toMatchObject({ value: 1, passed: true });
    }
  });

  test("no summary fails every scorer", () => {
    const scores = scoreRun(null, TRUTH);
    expect(scores.map((s) => s.scorer)).toEqual([
      "schema_valid", "medication_recall", "medication_precision", "allergy_recall", "dose_match", "hallucinations",
    ]);
    for (const s of scores) expect(s).toMatchObject({ value: 0, passed: false, detail: "no summary to score" });
    expect(schemaValid(PERFECT).passed).toBe(true);
  });

  test("medication recall names what was missed", () => {
    const s = medicationRecall(only({ medications: [m("lisinopril", "1 tablet", "daily")] }), TRUTH);
    expect(s.value).toBeCloseTo(1 / 3);
    expect(s.passed).toBe(false);
    expect(s.detail).toContain("Ventolin");
  });

  test("a stopped drug in the summary costs precision and counts as a hallucination", () => {
    const summary = only({ medications: [...PERFECT.medications, m("Ibuprofen 200 MG Oral Tablet")] });
    expect(medicationPrecision(summary, TRUTH)).toMatchObject({ value: 0.75, passed: false, detail: "not on record: Ibuprofen 200 MG Oral Tablet" });
    expect(hallucinations(summary, TRUTH)).toMatchObject({ passed: false, detail: "1 not on record: medication Ibuprofen 200 MG Oral Tablet" });
    expect(medicationRecall(summary, TRUTH).passed).toBe(true);
  });

  test("one missed allergy fails allergy recall; allergic disposition is never expected", () => {
    const s = allergyRecall(only({ allergies: [a("shellfish"), a("dust mite")] }), TRUTH);
    expect(s).toMatchObject({ value: 2 / 3, passed: false, detail: "missed: Tree pollen" });
    expect(allergyRecall(only({ allergies: [...PERFECT.allergies, a("allergic disposition")] }), TRUTH).passed).toBe(true);
    expect(hallucinations(only({ allergies: [...PERFECT.allergies, a("allergic disposition")] }), TRUTH).passed).toBe(true);
  });

  test("a whole med-list line as the name still matches, and only the name is matched", () => {
    const line = only({ medications: [m("lisinopril 10 MG Oral Tablet, 1 tablet, QD", "1 tablet", "QD"), ...PERFECT.medications.slice(1)] });
    for (const s of scoreRun(line, TRUTH)) expect(s).toMatchObject({ passed: true });
    const wrong = only({ medications: [m("lisinopril 20 MG Oral Tablet, 1 tablet, QD"), ...PERFECT.medications.slice(1)] });
    expect(medicationRecall(wrong, TRUTH).passed).toBe(false);
  });

  test("NKDA, None or Unknown listed as an allergy is not a made-up allergy", () => {
    for (const placeholder of ["NKDA", "None", "Unknown", "unspecified", "No known allergies"]) {
      const summary = only({ allergies: [...PERFECT.allergies, a(placeholder)] });
      expect(hallucinations(summary, TRUTH)).toMatchObject({ value: 1, passed: true });
      expect(allergyRecall(summary, TRUTH).passed).toBe(true);
    }
    expect(hallucinations(only({ allergies: [...PERFECT.allergies, a("Unknown mold")] }), TRUTH).passed).toBe(false);
  });

  test("no allergies on record and none listed passes", () => {
    const truth = { ...TRUTH, allergies: [allergy("Allergic disposition (finding)", "609328004")] };
    expect(allergyRecall(only({ allergies: [] }), truth)).toMatchObject({ value: 1, passed: true });
  });

  test("dose match catches the stale dose from a dose-change note, and a wrong frequency", () => {
    const stale = only({ medications: [m("lisinopril", "2 tablets", "once daily"), ...PERFECT.medications.slice(1)] });
    expect(doseMatch(stale, TRUTH)).toMatchObject({ value: 0.5, passed: false });
    expect(doseMatch(stale, TRUTH).detail).toContain('dose "2 tablets", expected 1');
    const bid = only({ medications: [m("lisinopril", "10 MG", "BID"), ...PERFECT.medications.slice(1)] });
    expect(doseMatch(bid, TRUTH).detail).toContain('frequency "BID"');
    const prnMissing = only({ medications: [PERFECT.medications[0]!, m("Ventolin", null, null)] });
    expect(doseMatch(prnMissing, TRUTH).detail).toContain("albuterol");
  });

  test("dose match only checks medications with a recorded dose or timing", () => {
    const truth = { ...TRUTH, medications: [med("Clopidogrel 75 MG Oral Tablet")] };
    const s = doseMatch(only({ medications: [m("clopidogrel", "whatever", "whenever")] }), truth);
    expect(s).toMatchObject({ value: 1, passed: true, detail: "no recorded dose or timing to check" });
  });

  test("an empty record with an empty summary passes everything", () => {
    const truth: GroundTruth = { ...TRUTH, medications: [], allergies: [] };
    const empty: Summary = { narrative: "", medications: [], allergies: [], conditions: [] };
    for (const s of scoreRun(empty, truth)) expect(s).toMatchObject({ value: 1, passed: true });
  });
});

test("alignment flags what the scorers count as missed and made up", () => {
  const summary = only({
    medications: [m("lisinopril 10 MG Oral Tablet, 1 tablet, QD"), m("Ibuprofen 200 MG Oral Tablet")],
    allergies: [a("shellfish"), a("NKDA"), a("peanuts")],
  });
  const al = alignment(summary, TRUTH);
  expect(al.medications.record.map((x) => x.found)).toEqual([true, false, false]);
  expect(al.medications.summary.map((x) => x.onRecord)).toEqual([true, false]);
  expect(al.allergies.record.map((x) => [x.substance, x.found])).toEqual([["Shellfish", true], ["Tree pollen", false], ["House dust mite", false]]);
  expect(al.allergies.summary.map((x) => [x.substance, x.onRecord, x.placeholder])).toEqual([["shellfish", true, false], ["NKDA", false, true], ["peanuts", false, false]]);
  // the same items the scorers report
  expect(allergyRecall(summary, TRUTH).detail).toBe("missed: Tree pollen; House dust mite");
  expect(hallucinations(summary, TRUTH).detail).toBe("2 not on record: medication Ibuprofen 200 MG Oral Tablet; allergy peanuts");
});
