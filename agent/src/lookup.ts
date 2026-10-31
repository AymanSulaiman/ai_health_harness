// lookup_medication: agent v2's tool. Finds the standard names closest to a drug name as
// written in a note, from every drug Synthea prescribes (data/med_reference.json, built by
// `ai-health-harness med-reference`).
import { existsSync, readFileSync } from "node:fs";
import type { ToolSpec } from "./model";

export type Drug = { name: string; rxnorm: string };

const REFERENCE = `${import.meta.dir}/../../data/med_reference.json`;

export const lookupSpec: ToolSpec = {
  name: "lookup_medication",
  description:
    "Find the standard name of a medication as written in a clinical note, including abbreviations and misspellings. " +
    "Returns up to 3 candidates, best first, each with a match score from 0 to 1.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The medication as written, e.g. 'lisinopril 10mg' or 'HCTZ 25'" } },
    required: ["query"],
  },
};

/** Lower-case letter and digit trigrams, padded so short words still count. */
function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []) {
    const padded = `  ${word} `;
    for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Share of the query's trigrams found in the name. Asymmetric on purpose: a short query
 * ("lisinopril 10") should fully match a long standard name ("lisinopril 10 MG Oral Tablet").
 * ponytail: linear scan over ~300 names per call; index it if the list grows to thousands.
 */
function score(query: Set<string>, name: Set<string>): number {
  if (query.size === 0) return 0;
  let shared = 0;
  for (const g of query) if (name.has(g)) shared++;
  return shared / query.size;
}

export function lookup(query: string, reference: Drug[]): (Drug & { score: number })[] {
  const q = trigrams(query);
  return reference
    .map((d) => ({ ...d, score: Math.round(score(q, trigrams(d.name)) * 100) / 100 }))
    .filter((d) => d.score >= 0.3)
    .toSorted((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, 3);
}

let cached: Drug[] | undefined;

/** The reference list, read once. Throws with the command to build it when it is missing. */
export function reference(path = REFERENCE): Drug[] {
  if (!cached) {
    if (!existsSync(path)) throw new Error(`${path} not found; build it with: uv run --project data_processing ai-health-harness med-reference`);
    cached = JSON.parse(readFileSync(path, "utf8")) as Drug[];
  }
  return cached;
}
