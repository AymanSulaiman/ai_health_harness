import { expect, test } from "bun:test";
import { lookup } from "./lookup";

const REF = [
  { name: "lisinopril 10 MG Oral Tablet", rxnorm: "1" },
  { name: "hydrochlorothiazide 12.5 MG / lisinopril 10 MG Oral Tablet", rxnorm: "2" },
  { name: "Hydrochlorothiazide 25 MG Oral Tablet", rxnorm: "3" },
  { name: "Acetaminophen 325 MG Oral Tablet [Tylenol]", rxnorm: "4" },
  { name: "Loratadine 10 MG Oral Tablet", rxnorm: "5" },
];

test.each([
  ["lisinopril 10mg", "lisinopril 10 MG Oral Tablet"], // ties with the combination pill; the shorter name wins
  ["lisnpr 10 MG Oral Tablet", "lisinopril 10 MG Oral Tablet"], // misspelt
  ["Tylenol", "Acetaminophen 325 MG Oral Tablet [Tylenol]"], // brand
  ["HCTZ 25", "Hydrochlorothiazide 25 MG Oral Tablet"], // abbreviation, weakly
])("%p finds %p first", (query, name) => {
  expect(lookup(query, REF)[0]!.name).toBe(name);
});

test("at most 3 candidates, best first, nothing below 0.3", () => {
  const found = lookup("lisinopril", REF);
  expect(found.length).toBeLessThanOrEqual(3);
  expect(found.map((d) => d.score)).toEqual(found.map((d) => d.score).toSorted((a, b) => b - a));
  expect(lookup("zzzz", REF)).toEqual([]);
});
