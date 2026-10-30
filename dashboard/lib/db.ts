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

/** A version as the overview lists it, from serving.agg_version_summary. */
export type VersionSummary = {
  agent_key: string;
  agent_version: string;
  prompt_version: string;
  agent_model: string;
  first_run_at: string;
  suite_count: number;
  run_count: number;
  pass_rate: number;
  deterministic_pass_rate: number;
  judge_pass_rate: number | null;
  p50_latency_ms: number;
  p95_latency_ms: number;
  mean_output_tokens: number;
};

export const versionSummaries = () =>
  query<VersionSummary>(`
    select
      agent_key, agent_version, prompt_version, agent_model,
      strftime(first_run_at, '%Y-%m-%d %H:%M') as first_run_at,
      suite_count::int as suite_count, run_count::int as run_count,
      pass_rate, deterministic_pass_rate, judge_pass_rate,
      p50_latency_ms, p95_latency_ms, mean_output_tokens
    from serving.agg_version_summary
    order by first_run_at desc
  `);
