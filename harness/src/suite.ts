// Suite runner: every test case through the agent, scored, one trace event each.
//   bun run eval                          a new suite run over datasets/notes_v1.jsonl
//   bun run eval --suite <id>             resume it: cases with an event already are skipped
//   bun run eval --concurrency 2 --limit 10
//   bun run eval --skip-judge             deterministic scorers only
//   bun run eval --agent 2                another agent version (AGENTS in agent/src/summarise.ts)
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AGENTS, modelClient, summarise, type Agent, type ModelClient } from "agent";
import models from "../../models.json" with { type: "json" };
import { TraceEvent } from "shared-types";
import type { GroundTruth } from "./ground-truth";
import { JUDGE_PROMPT_VERSION, judge } from "./judge";
import { scoreRun } from "./scorers";
import { emit, TRACES_DIR } from "./traces";

export type Case = { case_id: string; dataset_version: string; categories: string[]; note: string; ground_truth: GroundTruth };

/** Events already written for a suite run. */
export function readEvents(suiteRunId: string, dir = TRACES_DIR): TraceEvent[] {
  const file = `${dir}/${suiteRunId}.jsonl`;
  if (!existsSync(file)) return [];
  // ponytail: a line cut short by a kill mid-write would throw here; delete it by hand if it ever happens
  return readFileSync(file, "utf8").trim().split("\n").map((l) => TraceEvent.parse(JSON.parse(l)));
}

const passed = (e: TraceEvent) => e.error === null && e.scores.every((s) => s.passed);

/** One case: run, score, judge, emit. Never throws for a bad run; only an invalid event does. */
async function runCase(c: Case, agent: Agent, client: ModelClient, judgeClient: ModelClient | null, suiteRunId: string, dir: string): Promise<TraceEvent> {
  const run = await summarise(c.note, client, agent);
  const scores: TraceEvent["scores"] = [];
  let error = run.error;
  if (!error && run.parsed_output) {
    try {
      scores.push(...scoreRun(run.parsed_output, c.ground_truth));
      if (judgeClient) scores.push(...(await judge(c.note, c.ground_truth, run.parsed_output, judgeClient)));
    } catch (e) {
      // the deterministic scores are kept when only the judge failed
      error = { stage: "score", message: e instanceof Error ? e.message : String(e) };
    }
  }
  const event: TraceEvent = {
    run_id: crypto.randomUUID(),
    suite_run_id: suiteRunId,
    test_case_id: c.case_id,
    dataset_version: c.dataset_version,
    agent_version: agent.version,
    agent_model: client.spec,
    prompt_version: agent.promptVersion,
    judge_model: judgeClient?.spec ?? null,
    judge_prompt_version: judgeClient ? JUDGE_PROMPT_VERSION : null,
    ...run,
    scores,
    error,
    created_at: new Date().toISOString(),
  };
  emit(event, dir);
  return event;
}

/**
 * Runs every case without an event in this suite run yet, `concurrency` at a time.
 * Returns all of the suite run's events, earlier ones included.
 */
export async function runSuite(opts: {
  cases: Case[];
  client: ModelClient;
  agent?: Agent; // default: agent 1
  judge?: ModelClient | null; // null or left out: no LLM judge
  suiteRunId: string;
  concurrency: number;
  dir?: string;
  log?: (line: string) => void;
}): Promise<TraceEvent[]> {
  const { cases, client, agent = AGENTS["1"]!, judge: judgeClient = null, suiteRunId, concurrency, dir = TRACES_DIR, log = console.log } = opts;
  // ponytail: any event counts as done, errors too, so the raw layer keeps one row per case
  const done = new Set(readEvents(suiteRunId, dir).map((e) => e.test_case_id));
  const todo = cases.filter((c) => !done.has(c.case_id));
  log(`suite ${suiteRunId}: ${todo.length} to run, ${done.size} already done`);

  let next = 0;
  let finished = done.size;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++]!;
      const e = await runCase(c, agent, client, judgeClient, suiteRunId, dir);
      const failed = e.error ? [`error (${e.error.stage}): ${e.error.message}`] : e.scores.filter((s) => !s.passed).map((s) => s.scorer);
      log(`[${++finished}/${cases.length}] ${c.case_id} ${passed(e) ? "PASS" : "FAIL"} ${(e.latency_ms / 1000).toFixed(1)}s ${failed.join(", ")}`.trimEnd());
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return readEvents(suiteRunId, dir);
}

/** Pass rate overall and per scorer. */
export function report(events: TraceEvent[]): string {
  const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;
  const lines = [`passed every check: ${pct(events.filter(passed).length, events.length)}`];
  const errors = events.filter((e) => e.error).length;
  if (errors) lines.push(`errors: ${errors}`);
  const scorers = [...new Set(events.flatMap((e) => e.scores.map((s) => s.scorer)))];
  for (const name of scorers) {
    const scored = events.flatMap((e) => e.scores.filter((s) => s.scorer === name));
    lines.push(`  ${name.padEnd(22)} ${pct(scored.filter((s) => s.passed).length, scored.length)}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "v1" },
      suite: { type: "string" },
      concurrency: { type: "string", default: "4" },
      limit: { type: "string" },
      "skip-judge": { type: "boolean", default: false },
      agent: { type: "string", default: "1" },
    },
  });
  const path = `${import.meta.dir}/../../datasets/notes_${values.dataset}.jsonl`;
  if (!existsSync(path)) {
    console.error(`${path} not found; build it with: uv run --project data_processing ai-health-harness`);
    process.exit(1);
  }
  const all: Case[] = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cases = values.limit ? all.slice(0, Number(values.limit)) : all;
  const suiteRunId = values.suite ?? new Date().toISOString().replace(/[:.]/g, "-");

  const agent = AGENTS[values.agent];
  if (!agent) {
    console.error(`unknown agent "${values.agent}"; known: ${Object.keys(AGENTS).join(", ")}`);
    process.exit(1);
  }
  const events = await runSuite({ cases, client: modelClient(models.agent), agent,
    judge: values["skip-judge"] ? null : modelClient(models.judge),
    suiteRunId, concurrency: Number(values.concurrency) });
  console.log(`\n${report(events)}\ntraces: data/traces/${suiteRunId}.jsonl`);
}
