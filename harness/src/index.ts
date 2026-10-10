// Step 1: prove the TypeScript side can read what the Python side wrote.
//   bun harness/src/index.ts

// The shape of one line in data/ground_truth.jsonl.
// ponytail: hand-copied from schemas/ground_truth.schema.json, so the two can drift;
// check records against the schema itself once a scorer depends on these fields.
type GroundTruth = {
  patient_id: string;
  as_of: string;
  medications: {
    name: string;
    rxnorm: string;
    as_needed: boolean | null;
    dose: number | null;
    timing: { frequency: number; period: number; period_unit: string } | null;
  }[];
  allergies: {
    substance: string;
    snomed: string;
    category: string | null;
    type: string | null;
    reactions: { manifestation: string; severity: string | null }[];
  }[];
  conditions: { name: string; system: string; code: string; onset: string | null }[];
};

// import.meta.dir is this file's folder, so the path works from any directory
const path = `${import.meta.dir}/../../data/ground_truth.jsonl`;
const text = await Bun.file(path).text();
const records: GroundTruth[] = text
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const withAllergies = records.filter((r) => r.allergies.length > 0).length;
console.log(`${records.length} patients, ${withAllergies} with at least one allergy`);
