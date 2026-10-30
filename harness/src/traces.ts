// Trace emitter: appends each run's event to data/traces/<suite_run_id>.jsonl, one per line.
// The raw layer is these files; DuckDB reads them with read_json('data/traces/*.jsonl').
// ponytail: JSONL files, not inserts into warehouse.duckdb, because DuckDB lets one process
// write a database file at a time and the Python side opens it too.
import { appendFileSync, mkdirSync } from "node:fs";
import { TraceEvent } from "shared-types";

export const TRACES_DIR = `${import.meta.dir}/../../data/traces`;

/** Validates the event, then appends it. Throws on an invalid event; nothing is written. Never rewrites a line. */
export function emit(event: TraceEvent, dir = TRACES_DIR): void {
  const valid = TraceEvent.parse(event);
  mkdirSync(dir, { recursive: true });
  appendFileSync(`${dir}/${valid.suite_run_id}.jsonl`, `${JSON.stringify(valid)}\n`);
}
