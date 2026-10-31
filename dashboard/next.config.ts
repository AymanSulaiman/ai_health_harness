import type { NextConfig } from "next";

// DuckDB is a native module: load it from node_modules at runtime, don't bundle it.
// harness and shared-types are TypeScript source in this repo; Next compiles them.
const config: NextConfig = { serverExternalPackages: ["@duckdb/node-api"], transpilePackages: ["harness", "shared-types"] };
export default config;
