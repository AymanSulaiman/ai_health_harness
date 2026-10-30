// The shape of one line in data/ground_truth.jsonl, and of each case's ground_truth.
// ponytail: hand-copied from schemas/ground_truth.schema.json, so the two can drift;
// generate it from the schema if it changes often.
export type GroundTruth = {
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
