// Deterministic scorers: pure functions comparing a run's Summary with the case's ground
// truth. Each returns one Score for the trace event's `scores` field. A run with no
// summary (a model or parse error) fails every scorer.
import type { Score, Summary } from "shared-types";
import type { GroundTruth } from "./ground-truth";

type Med = GroundTruth["medications"][number];
type Allergy = GroundTruth["allergies"][number];

// ---------- matching names ----------

// Words that say how a drug is packaged, or what kind of thing an allergen is, not what it is.
const NOISE = new Set(
  ("mg mcg ml unt hr actuat oral tablet tab capsule cap injection injectable suspension solution " +
    "extended release delayed er xr sr xl cr dr metered dose inhaler inhalation powder dry spray mucosal nasal auto " +
    "injector topical cream ointment patch transdermal system pack day hydrochloride hcl sodium " +
    "potassium succinate maleate phosphate tartrate citrate besylate chewable prefilled syringe pen " +
    "po daily prn allergy allergic intolerance to of the and edible substance organism finding")
    .split(" "),
);

/** Lower-case words (plurals folded, noise dropped) and the numbers in a name. */
export function tokens(name: string): { words: Set<string>; numbers: Set<string> } {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const t of name.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []) {
    if (/\d/.test(t)) numbers.add(String(Number(t)));
    else if (t.length > 1) {
      const word = t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
      if (!NOISE.has(word) && !NOISE.has(t)) words.add(word);
    }
  }
  return { words, numbers };
}

/**
 * How well an output name matches a ground-truth name, 0 to 1: the share of the output's
 * words found in the truth's. Any number in the output (a strength) must appear in the
 * truth, so "lisinopril 20 mg" never matches a 10 MG prescription.
 */
export function similarity(output: string, truth: string): number {
  const o = tokens(output);
  const t = tokens(truth);
  if (o.words.size === 0 || [...o.numbers].some((n) => !t.numbers.has(n))) return 0;
  return [...o.words].filter((w) => t.words.has(w)).length / o.words.size;
}

/**
 * Pair outputs with truths one-to-one, best matches first. A pair needs more than half
 * of the output's words in the truth, so "tree pollen" never matches "grass pollen".
 * ponytail: greedy, not optimal assignment; fine for a handful of items per patient.
 */
export function match(outputs: string[], truths: string[]): [number, number][] {
  const candidates: [number, number, number][] = [];
  outputs.forEach((o, i) =>
    truths.forEach((t, j) => {
      const s = similarity(o, t);
      if (s > 0.5) candidates.push([s, i, j]);
    }),
  );
  candidates.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const usedO = new Set<number>();
  const usedT = new Set<number>();
  const pairs: [number, number][] = [];
  for (const [, i, j] of candidates) {
    if (usedO.has(i) || usedT.has(j)) continue;
    usedO.add(i);
    usedT.add(j);
    pairs.push([i, j]);
  }
  return pairs;
}

// ---------- reading doses and frequencies ----------

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, half: 0.5 };

/** The leading amount in a dose like "1 tablet", "2 puffs", "10 MG", "one tablet". */
export function doseAmount(dose: string): number | null {
  const m = dose.trim().toLowerCase().match(/^(\d+(?:\.\d+)?|one|two|three|four|half)\b/);
  if (!m) return null;
  return WORD_NUMBERS[m[1]!] ?? Number(m[1]);
}

/** Times per day, or "prn" for as needed; null when unreadable. */
export function frequencyRate(frequency: string): number | "prn" | null {
  const f = frequency.toLowerCase();
  if (/\bprn\b|as needed|when needed|if needed/.test(f)) return "prn";
  let m = f.match(/\bq\s*(\d+(?:\.\d+)?)\s*h|every (\d+(?:\.\d+)?) hours?/);
  if (m) return 24 / Number(m[1] ?? m[2]);
  if (/every other day|\bqod\b/.test(f)) return 0.5;
  m = f.match(/every (\d+) days?/);
  if (m) return 1 / Number(m[1]);
  m = f.match(/every (\d+) weeks?/);
  if (m) return 1 / (7 * Number(m[1]));
  if (/\bqid\b|four times/.test(f)) return 4;
  if (/\btid\b|three times/.test(f)) return 3;
  if (/\bbid\b|twice/.test(f)) return 2;
  m = f.match(/(\d+) times (?:a|per) day|(\d+) times daily/);
  if (m) return Number(m[1] ?? m[2]);
  if (/\bqd\b|\bdaily\b|once a day|once daily|every day|\bqam\b|\bqhs\b|at bedtime|nightly|weekly/.test(f))
    return /weekly/.test(f) ? 1 / 7 : 1;
  return null;
}

const PER_DAY: Record<string, number> = { s: 86400, min: 1440, h: 24, d: 1, wk: 1 / 7, mo: 1 / 30, a: 1 / 365 };

function truthRate(med: Med): number | "prn" | null {
  if (med.as_needed) return "prn";
  if (!med.timing) return null;
  const { frequency, period, period_unit } = med.timing;
  return (frequency * (PER_DAY[period_unit] ?? NaN)) / period;
}

/** The first strength in a name, e.g. 10 for "lisinopril 10 MG Oral Tablet". */
function strength(name: string): number | null {
  const m = name.match(/(\d+(?:\.\d+)?)\s*(?:MG|MCG|ML|UNT)\b/i);
  return m ? Number(m[1]) : null;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

/**
 * Whether an output dose is right for a ground-truth dose in units (1 = one tablet).
 * "1 tablet" is right, and so is the same amount as a strength: "10 MG" for one
 * 10 MG tablet. The stale "2 tablets" from a dose-change note is wrong.
 */
export function doseRight(output: string | null, truth: Med): boolean {
  if (truth.dose === null) return true;
  if (output === null) return false;
  const amount = doseAmount(output);
  if (amount === null) return false;
  if (near(amount, truth.dose)) return true;
  const s = strength(truth.name);
  return s !== null && /mg|mcg|ml|unit/i.test(output) && near(amount, truth.dose * s);
}

export function frequencyRight(output: string | null, truth: Med): boolean {
  const expected = truthRate(truth);
  if (expected === null) return true;
  if (output === null) return false;
  const got = frequencyRate(output);
  return got === expected || (typeof got === "number" && typeof expected === "number" && near(got, expected));
}

// ---------- scorers ----------

const NO_SUMMARY = "no summary to score";

// Synthea records a general tendency to allergies as an allergy; it names no substance,
// so a summary is not expected to list it.
// ponytail: one code; add others here if Synthea gains more non-substance entries
const NOT_A_SUBSTANCE = new Set(["609328004"]); // Allergic disposition (finding)

const scorable = (truth: GroundTruth): Allergy[] => truth.allergies.filter((a) => !NOT_A_SUBSTANCE.has(a.snomed));
const plain = (s: string) => s.replace(/\s*\([^)]*\)$/, "");
const fraction = (n: number, of: number) => (of === 0 ? 1 : n / of);
const list = (names: string[]) => names.join("; ");

function score(scorer: string, value: number, passed: boolean, detail: string | null): Score {
  return { scorer, value, passed, detail };
}
const failed = (scorer: string): Score => score(scorer, 0, false, NO_SUMMARY);

export function schemaValid(summary: Summary | null): Score {
  return summary ? score("schema_valid", 1, true, null) : score("schema_valid", 0, false, NO_SUMMARY);
}

/** Share of the patient's medications the summary lists. */
export function medicationRecall(summary: Summary | null, truth: GroundTruth): Score {
  if (!summary) return failed("medication_recall");
  const pairs = match(summary.medications.map((m) => m.name), truth.medications.map((m) => m.name));
  const found = new Set(pairs.map(([, j]) => j));
  const missed = truth.medications.filter((_, j) => !found.has(j)).map((m) => m.name);
  const value = fraction(found.size, truth.medications.length);
  return score("medication_recall", value, missed.length === 0, missed.length ? `missed: ${list(missed)}` : null);
}

/** Share of the summary's medications the patient actually takes. A stopped drug counts against it. */
export function medicationPrecision(summary: Summary | null, truth: GroundTruth): Score {
  if (!summary) return failed("medication_precision");
  const pairs = match(summary.medications.map((m) => m.name), truth.medications.map((m) => m.name));
  const matched = new Set(pairs.map(([i]) => i));
  const extra = summary.medications.filter((_, i) => !matched.has(i)).map((m) => m.name);
  const value = fraction(matched.size, summary.medications.length);
  return score("medication_precision", value, extra.length === 0, extra.length ? `not on record: ${list(extra)}` : null);
}

/** Share of the patient's allergies the summary lists. Any miss fails: these are the dangerous ones. */
export function allergyRecall(summary: Summary | null, truth: GroundTruth): Score {
  if (!summary) return failed("allergy_recall");
  const allergies = scorable(truth);
  const pairs = match(summary.allergies.map((a) => a.substance), allergies.map((a) => a.substance));
  const found = new Set(pairs.map(([, j]) => j));
  const missed = allergies.filter((_, j) => !found.has(j)).map((a) => plain(a.substance));
  const value = fraction(found.size, allergies.length);
  return score("allergy_recall", value, missed.length === 0, missed.length ? `missed: ${list(missed)}` : null);
}

/** For each listed medication with a recorded dose or timing: are both right? */
export function doseMatch(summary: Summary | null, truth: GroundTruth): Score {
  if (!summary) return failed("dose_match");
  const pairs = match(summary.medications.map((m) => m.name), truth.medications.map((m) => m.name));
  const wrong: string[] = [];
  let checked = 0;
  for (const [i, j] of pairs) {
    const out = summary.medications[i]!;
    const med = truth.medications[j]!;
    if (med.dose === null && truthRate(med) === null) continue; // nothing recorded to check against
    checked++;
    const problems = [
      !doseRight(out.dose, med) && `dose "${out.dose}", expected ${med.dose}`,
      !frequencyRight(out.frequency, med) && `frequency "${out.frequency}"`,
    ].filter(Boolean);
    if (problems.length) wrong.push(`${med.name}: ${problems.join(", ")}`);
  }
  const value = fraction(checked - wrong.length, checked);
  const detail = wrong.length ? list(wrong) : checked ? null : "no recorded dose or timing to check";
  return score("dose_match", value, wrong.length === 0, detail);
}

/**
 * Medications and allergies in the summary that are not in the record. The value is the
 * share of listed items that are on record; passed means none were made up.
 * ponytail: conditions are left to the LLM judge (KAN-21); "HTN" or "pre-DM" defeat
 * string matching.
 */
export function hallucinations(summary: Summary | null, truth: GroundTruth): Score {
  if (!summary) return failed("hallucinations");
  const medPairs = match(summary.medications.map((m) => m.name), truth.medications.map((m) => m.name));
  const allergyPairs = match(summary.allergies.map((a) => a.substance), truth.allergies.map((a) => a.substance));
  const medHit = new Set(medPairs.map(([i]) => i));
  const allergyHit = new Set(allergyPairs.map(([i]) => i));
  const made = [
    ...summary.medications.filter((_, i) => !medHit.has(i)).map((m) => `medication ${m.name}`),
    ...summary.allergies.filter((_, i) => !allergyHit.has(i)).map((a) => `allergy ${a.substance}`),
  ];
  const total = summary.medications.length + summary.allergies.length;
  const value = fraction(total - made.length, total);
  return score("hallucinations", value, made.length === 0, made.length ? `${made.length} not on record: ${list(made)}` : null);
}

/** Every deterministic score for one run, in a fixed order. */
export function scoreRun(summary: Summary | null, truth: GroundTruth): Score[] {
  return [
    schemaValid(summary),
    medicationRecall(summary, truth),
    medicationPrecision(summary, truth),
    allergyRecall(summary, truth),
    doseMatch(summary, truth),
    hallucinations(summary, truth),
  ];
}
