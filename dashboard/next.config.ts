import type { NextConfig } from "next";

// DuckDB is a native module: load it from node_modules at runtime, don't bundle it.
const config: NextConfig = { serverExternalPackages: ["@duckdb/node-api"] };
export default config;
