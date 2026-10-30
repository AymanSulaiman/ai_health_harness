import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ModelClient } from "agent";
import { readEvents, report, runSuite, type Case } from "./suite";

const truth = {
  patient_id: "p", as_of: "2026-01-01",
  medications: [{ name: "lisinopril 10 MG Oral Tablet", rxnorm: "x", as_needed: false, dose: 1, timing: { frequency: 1, period: 1, period_unit: "d" } }],
  allergies: [], conditions: [],
};
const cases: Case[] = Array.from({ length: 6 }, (_, i) => ({
  case_id: `v1-00${i + 1}`, dataset_version: "v1", categories: [], note: `note ${i + 1}`, ground_truth: truth,
}));
const good = { narrative: "", medications: [{ name: "lisinopril 10 mg", dose: "1 tablet", frequency: "daily" }], allergies: [], conditions: [] };

/** Replies after a short delay; note 2 gets a summary missing its medication, note 3 a model failure. */
function fake() {
  let active = 0;
  const stats = { calls: 0, peak: 0 };
  const client: ModelClient = {
    spec: "fake/model",
    async chat(messages) {
      stats.calls++;
      stats.peak = Math.max(stats.peak, ++active);
      await Bun.sleep(5);
      active--;
      const note = messages.at(-1)!.content;
      if (note === "note 3") throw new Error("connection refused");
      const summary = note === "note 2" ? { ...good, medications: [] } : good;
      return { text: JSON.stringify(summary), input_tokens: 10, output_tokens: 5, latency_ms: 5 };
    },
  };
  return { client, stats };
}

test("runs every case once, scores it and writes one event each, at most `concurrency` at a time", async () => {
  const dir = mkdtempSync(`${tmpdir()}/suite-`);
  const { client, stats } = fake();
  const events = await runSuite({ cases, client, suiteRunId: "s1", concurrency: 2, dir, log: () => {} });

  expect(events.map((e) => e.test_case_id).sort()).toEqual(cases.map((c) => c.case_id));
  expect(stats.peak).toBe(2);
  const byCase = Object.fromEntries(events.map((e) => [e.test_case_id, e]));
  expect(byCase["v1-001"]!.scores.every((s) => s.passed)).toBe(true);
  expect(byCase["v1-002"]!.scores.find((s) => s.scorer === "medication_recall")!.passed).toBe(false);
  expect(byCase["v1-003"]!).toMatchObject({ error: { stage: "model" }, scores: [] });
  expect(report(events)).toContain("passed every check: 4/6 (67%)");
  expect(report(events)).toContain("errors: 1");
});

test("a rerun with the same suite id runs only the cases without an event", async () => {
  const dir = mkdtempSync(`${tmpdir()}/suite-`);
  // first run "killed" after 2 cases
  await runSuite({ cases: cases.slice(0, 2), client: fake().client, suiteRunId: "s1", concurrency: 1, dir, log: () => {} });
  const { client, stats } = fake();
  const events = await runSuite({ cases, client, suiteRunId: "s1", concurrency: 3, dir, log: () => {} });

  expect(stats.calls).toBe(4); // v1-003 to v1-006 only
  expect(events).toHaveLength(6);
  expect(new Set(readEvents("s1", dir).map((e) => e.test_case_id)).size).toBe(6);
});

test("judge scores sit beside the deterministic ones; a failing judge keeps those and records the error", async () => {
  const dir = mkdtempSync(`${tmpdir()}/suite-`);
  const grade = { score: 5, rationale: "fine" };
  let calls = 0;
  const judgeClient: ModelClient = {
    spec: "fake/judge",
    async chat() {
      // the first case's judge replies fine; every later call is unusable
      const text = ++calls === 1 ? JSON.stringify({ faithfulness: grade, usefulness: grade, omissions: grade }) : "nope";
      return { text, input_tokens: 1, output_tokens: 1, latency_ms: 1 };
    },
  };
  const [ok, broken] = await runSuite({ cases: cases.slice(0, 2), client: fake().client, judge: judgeClient, suiteRunId: "s1", concurrency: 1, dir, log: () => {} });
  expect(ok!).toMatchObject({ judge_model: "fake/judge", judge_prompt_version: "1", error: null });
  expect(ok!.scores.map((s) => s.scorer)).toContain("judge_omissions");
  expect(ok!.scores).toHaveLength(9);
  expect(broken!.error).toMatchObject({ stage: "score" });
  expect(broken!.scores).toHaveLength(6);
});
