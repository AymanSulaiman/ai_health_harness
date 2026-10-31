import Link from "next/link";
import { categoryRates, failingCases, versions as loadVersions, type Version } from "@/lib/db";
import { CategoryBars, PassRateLine } from "./charts";

// Read the warehouse on every request, so a new `make eval` shows up on reload.
export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// ponytail: 5 points, because one version's own suite runs differ by up to ~10 points
// overall; below that a change is called noise. Tighten with more cases per suite.
const NOISE = 0.05;

type Verdict = { word: "Better" | "Worse" | "About the same"; why: string };

function verdict(now: Version, before: Version): Verdict {
  if ((now.mean_allergy_recall ?? 1) < (before.mean_allergy_recall ?? 1))
    return { word: "Worse", why: `allergy recall fell from ${pct(before.mean_allergy_recall)} to ${pct(now.mean_allergy_recall)}` };
  const change = now.pass_rate - before.pass_rate;
  const moved = `pass rate ${pct(before.pass_rate)} → ${pct(now.pass_rate)}`;
  if (change <= -NOISE) return { word: "Worse", why: moved };
  if (change >= NOISE) return { word: "Better", why: moved };
  return { word: "About the same", why: `${moved}, within the ${Math.round(NOISE * 100)}-point noise between runs` };
}

/** A headline number with its change from the previous version; `higherIsBetter` decides the arrow's colour. */
function Tile({ name, value, change, higherIsBetter = true }: { name: string; value: string; change?: { text: string; delta: number }; higherIsBetter?: boolean }) {
  const good = change && change.delta !== 0 && change.delta > 0 === higherIsBetter;
  const bad = change && change.delta !== 0 && !good;
  return (
    <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div className="text-sm text-[var(--ink-2)]">{name}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
      {change && (
        <div className={`mt-1 text-sm ${good ? "text-[var(--good-text)]" : bad ? "text-[var(--critical)]" : "text-[var(--muted)]"}`}>
          {change.delta === 0 ? "– no change" : `${change.delta > 0 ? "▲" : "▼"} ${change.text} ${good ? "better" : "worse"}`}
        </div>
      )}
    </div>
  );
}

const points = (a: number | null, b: number | null) =>
  a === null || b === null ? undefined : { delta: Math.round((a - b) * 1000) / 10, text: `${Math.abs(Math.round((a - b) * 1000) / 10)} pts` };

export default async function Overview({ searchParams }: { searchParams: Promise<{ version?: string }> }) {
  const all = await loadVersions();
  if (all.length === 0) return <p>No runs yet: run <code>make eval</code>.</p>;

  const byKey = new Map(all.map((v) => [v.agent_key, v]));
  const latest = all.at(-1)!;
  const latestBefore = latest.previous_agent_key ? byKey.get(latest.previous_agent_key) : undefined;
  const selected = byKey.get((await searchParams).version ?? "") ?? latest;
  const selectedBefore = selected.previous_agent_key ? byKey.get(selected.previous_agent_key) : undefined;
  const [rates, failing] = await Promise.all([
    categoryRates([selected.agent_key, ...(selectedBefore ? [selectedBefore.agent_key] : [])]),
    failingCases(selected.agent_key),
  ]);
  const v = latestBefore && verdict(latest, latestBefore);

  return (
    <div className="space-y-10">
      <section>
        <p className="text-sm text-[var(--ink-2)]">Latest version · agent {latest.agent_version}, prompt {latest.prompt_version} · {latest.agent_model}</p>
        <h1 className={`mt-1 text-3xl font-semibold ${v?.word === "Better" ? "text-[var(--good-text)]" : v?.word === "Worse" ? "text-[var(--critical)]" : ""}`}>
          {v ? `${v.word === "Better" ? "▲" : v.word === "Worse" ? "▼" : "●"} ${v.word} than the previous version` : "First version: nothing to compare yet"}
        </h1>
        {v && <p className="mt-1 text-[var(--ink-2)]">{v.why}</p>}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Tile name="Pass rate" value={pct(latest.pass_rate)} change={latestBefore && points(latest.pass_rate, latestBefore.pass_rate)} />
          <Tile name="Allergy recall" value={pct(latest.mean_allergy_recall)} change={latestBefore && points(latest.mean_allergy_recall, latestBefore.mean_allergy_recall)} />
          <Tile name="Runs with anything made up" value={pct(latest.hallucination_rate)} change={latestBefore && points(latest.hallucination_rate, latestBefore.hallucination_rate)} higherIsBetter={false} />
          <Tile
            name="p95 latency"
            value={secs(latest.p95_latency_ms)}
            change={latestBefore && { delta: Math.round(latest.p95_latency_ms - latestBefore.p95_latency_ms) / 1000, text: secs(Math.abs(latest.p95_latency_ms - latestBefore.p95_latency_ms)) }}
            higherIsBetter={false}
          />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Pass rate by version</h2>
        <p className="text-sm text-[var(--ink-2)]">Oldest to newest; hover a point for the version.</p>
        <div className="mt-3"><PassRateLine versions={all} /></div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Pass rate by test category</h2>
        <p className="text-sm text-[var(--ink-2)]">
          Agent {selected.agent_version}, prompt {selected.prompt_version}, worst first.
          {selectedBefore ? " The black tick is the previous version." : " No previous version to compare."}
        </p>
        <div className="mt-3"><CategoryBars rates={rates.filter((r) => r.agent_key === selected.agent_key)} previous={rates.filter((r) => r.agent_key === selectedBefore?.agent_key)} /></div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Failing cases ({failing.length})</h2>
        <p className="text-sm text-[var(--ink-2)]">
          In the latest suite run of agent {selected.agent_version}, prompt {selected.prompt_version}. Open one to see why.
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--grid)] text-[var(--ink-2)]">
              <tr>
                <th className="py-2 pr-4 font-medium">Case</th>
                <th className="py-2 pr-4 font-medium">Categories</th>
                <th className="py-2 pr-4 font-medium">Failed on</th>
              </tr>
            </thead>
            <tbody>
              {failing.map((c) => (
                <tr key={c.test_case_id} className="border-b border-[var(--grid)]">
                  <td className="py-2 pr-4 font-mono"><Link href={`/runs/${c.run_id}`} className="underline underline-offset-4">{c.test_case_id}</Link></td>
                  <td className="py-2 pr-4">{c.categories.map((x) => x.replaceAll("_", " ")).join(", ") || "–"}</td>
                  <td className="py-2 pr-4">{(c.failed_scorers ?? `error: ${c.error_stage}`).replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">All versions</h2>
        <p className="text-sm text-[var(--ink-2)]">Newest first; pick one to see its categories above.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="border-b border-[var(--grid)] text-[var(--ink-2)]">
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
              {all.toReversed().map((r) => (
                <tr key={r.agent_key} className={`border-b border-[var(--grid)] ${r.agent_key === selected.agent_key ? "font-semibold" : ""}`}>
                  <td className="py-2 pr-4">
                    <Link href={`/?version=${encodeURIComponent(r.agent_key)}`} className="underline decoration-[var(--axis)] underline-offset-4 hover:decoration-[var(--ink)]">
                      agent {r.agent_version}, prompt {r.prompt_version}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.agent_model}</td>
                  <td className="py-2 pr-4">{r.first_run_at}</td>
                  <td className="py-2 pr-4 text-right">{r.run_count} ({r.suite_count} suites)</td>
                  <td className="py-2 pr-4 text-right">{pct(r.pass_rate)}</td>
                  <td className="py-2 pr-4 text-right">{pct(r.deterministic_pass_rate)}</td>
                  <td className="py-2 pr-4 text-right">{pct(r.judge_pass_rate)}</td>
                  <td className="py-2 pr-4 text-right">{secs(r.p50_latency_ms)} / {secs(r.p95_latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
