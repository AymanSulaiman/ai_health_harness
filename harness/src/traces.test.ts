import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TraceEvent } from "shared-types";
import { examples } from "shared-types/examples";
import { emit } from "./traces";

const read = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => TraceEvent.parse(JSON.parse(l)));

test("appends one line per event, one file per suite run, never rewriting", () => {
  const dir = mkdtempSync(`${tmpdir()}/traces-`);
  for (const e of examples) emit(e, dir);
  emit({ ...examples[0]!, suite_run_id: "suite-2" }, dir);
  emit(examples[0]!, dir); // a repeat is appended, not merged

  expect(read(`${dir}/suite-1.jsonl`)).toEqual([...examples, examples[0]!]);
  expect(read(`${dir}/suite-2.jsonl`)).toHaveLength(1);
});

test("an invalid event throws and writes nothing", () => {
  const dir = mkdtempSync(`${tmpdir()}/traces-`);
  emit(examples[0]!, dir);
  const bad = { ...examples[0]!, latency_ms: -1 };
  expect(() => emit(bad, dir)).toThrow();
  expect(() => emit({ ...examples[0]!, extra: 1 } as TraceEvent, dir)).toThrow();
  expect(read(`${dir}/suite-1.jsonl`)).toHaveLength(1);
});
