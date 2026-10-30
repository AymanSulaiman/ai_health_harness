// Step 1: prove the TypeScript side can read what the Python side wrote.
//   bun harness/src/index.ts

import type { GroundTruth } from "./ground-truth";

// import.meta.dir is this file's folder, so the path works from any directory
const path = `${import.meta.dir}/../../data/ground_truth.jsonl`;
const text = await Bun.file(path).text();
const records: GroundTruth[] = text
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const withAllergies = records.filter((r) => r.allergies.length > 0).length;
console.log(`${records.length} patients, ${withAllergies} with at least one allergy`);
