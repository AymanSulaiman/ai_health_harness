// Server-only reads from the serving tables in data/warehouse.duckdb.
import "server-only";
import { DuckDBInstance } from "@duckdb/node-api";
import path from "node:path";

const WAREHOUSE = process.env.WAREHOUSE_PATH ?? path.resolve(process.cwd(), "../data/warehouse.duckdb");

/**
 * Runs one query on a read-only connection and closes it. The serving tables are tiny, so
 * opening per query is cheap, and holding the file open would block `make transform`:
 * DuckDB will not let a process write while another has the file open.
 */
export async function query<T>(sql: string): Promise<T[]> {
  const instance = await DuckDBInstance.create(WAREHOUSE, { access_mode: "READ_ONLY" });
  try {
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJS() as T[];
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

/** One agent version, from serving.agg_version_summary. */
export type Version = {
  agent_key: string;
  previous_agent_key: string | null;
  agent_version: string;
  prompt_version: string;
  agent_model: string;
  first_run_at: string;
  suite_count: number;
  run_count: number;
  pass_rate: number;
  deterministic_pass_rate: number;
  judge_pass_rate: number | null;
  mean_allergy_recall: number | null;
  hallucination_rate: number | null;
  p50_latency_ms: number;
  p95_latency_ms: number;
};

/** Every version, oldest first. */
export const versions = () =>
  query<Version>(`
    select
      agent_key, previous_agent_key, agent_version, prompt_version, agent_model,
      strftime(first_run_at, '%Y-%m-%d %H:%M') as first_run_at,
      suite_count::int as suite_count, run_count::int as run_count,
      pass_rate, deterministic_pass_rate, judge_pass_rate,
      mean_allergy_recall, hallucination_rate, p50_latency_ms, p95_latency_ms
    from serving.agg_version_summary
    order by first_run_at
  `);

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** A version's pass rate in one test category, from serving.agg_version_category. */
export type CategoryRate = { agent_key: string; category: string; is_trap: boolean; pass_rate: number; run_count: number };

/** Category pass rates for these versions. Keys come from versions(), never from the request. */
export const categoryRates = (agentKeys: string[]) =>
  query<CategoryRate>(`
    select agent_key, category, is_trap, pass_rate, run_count::int as run_count
    from serving.agg_version_category
    where agent_key in (${agentKeys.map(literal).join(", ") || "null"})
  `);

/** A test case that passed in one version and failed in the other, from serving.agg_version_case_result. */
export type FlippedCase = {
  test_case_id: string;
  categories: string[];
  passed_after: boolean;
  run_before: string;
  run_after: string;
  failed_before: string | null;
  failed_after: string | null;
};

/** Cases whose result differs between two versions' latest suite runs. Keys come from versions(). */
export const flippedCases = (before: string, after: string) =>
  query<FlippedCase>(`
    select
      b.test_case_id, b.categories, b.passed as passed_after,
      a.run_id as run_before, b.run_id as run_after,
      coalesce(a.failed_scorers, 'error: ' || a.error_stage) as failed_before,
      coalesce(b.failed_scorers, 'error: ' || b.error_stage) as failed_after
    from serving.agg_version_case_result a
    join serving.agg_version_case_result b using (test_case_id)
    where a.agent_key = ${literal(before)} and b.agent_key = ${literal(after)} and a.passed != b.passed
    order by b.test_case_id
  `);
