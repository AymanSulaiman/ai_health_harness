import { versionSummaries } from "@/lib/db";

// Read the warehouse on every request, so a new `make eval` shows up on reload.
export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export default async function Home() {
  const versions = await versionSummaries();
  return (
    <>
      <h1 className="text-2xl font-semibold">Agent versions</h1>
      <p className="mt-1 text-sm text-gray-500">Newest first. Pass rates are over every run of the version.</p>
      {versions.length === 0 ? (
        <p className="mt-6">No runs yet: run <code>make eval</code>.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="border-b border-gray-200 text-gray-500 dark:border-gray-800">
              <tr>
                <th className="py-2 pr-4 font-medium">Version</th>
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 font-medium">First run</th>
                <th className="py-2 pr-4 text-right font-medium">Runs</th>
                <th className="py-2 pr-4 text-right font-medium">Pass</th>
                <th className="py-2 pr-4 text-right font-medium">Deterministic</th>
                <th className="py-2 pr-4 text-right font-medium">Judge</th>
                <th className="py-2 pr-4 text-right font-medium">p50 / p95</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.agent_key} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-2 pr-4">agent {v.agent_version}, prompt {v.prompt_version}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{v.agent_model}</td>
                  <td className="py-2 pr-4">{v.first_run_at}</td>
                  <td className="py-2 pr-4 text-right">{v.run_count} ({v.suite_count} suites)</td>
                  <td className="py-2 pr-4 text-right font-semibold">{pct(v.pass_rate)}</td>
                  <td className="py-2 pr-4 text-right">{pct(v.deterministic_pass_rate)}</td>
                  <td className="py-2 pr-4 text-right">{pct(v.judge_pass_rate)}</td>
                  <td className="py-2 pr-4 text-right">{secs(v.p50_latency_ms)} / {secs(v.p95_latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
