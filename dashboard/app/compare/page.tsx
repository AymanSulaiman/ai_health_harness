import Link from "next/link";
import { categoryRates, flippedCases, versions as loadVersions, type FlippedCase, type Version } from "@/lib/db";

export const dynamic = "force-dynamic";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const name = (v: Version) => `agent ${v.agent_version}, prompt ${v.prompt_version} · ${v.agent_model}`;
const words = (s: string) => s.replaceAll("_", " ");

/** Change in points, coloured and arrowed so it never relies on colour alone. */
function Change({ delta }: { delta: number }) {
  const pts = Math.round(delta * 100);
  if (pts === 0) return <span className="text-[var(--muted)]">– same</span>;
  return pts > 0
    ? <span className="text-[var(--good-text)]">▲ {pts} pts helped</span>
    : <span className="text-[var(--critical)]">▼ {-pts} pts hurt</span>;
}

function CaseTable({ cases, failedColumn }: { cases: FlippedCase[]; failedColumn: "failed_before" | "failed_after" }) {
  if (cases.length === 0) return <p className="mt-2 text-sm text-[var(--muted)]">None.</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--grid)] text-[var(--ink-2)]">
          <tr>
            <th className="py-2 pr-4 font-medium">Case</th>
            <th className="py-2 pr-4 font-medium">Categories</th>
            <th className="py-2 pr-4 font-medium">{failedColumn === "failed_after" ? "Fails now on" : "Used to fail on"}</th>
            <th className="py-2 pr-4 font-medium">Traces</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.test_case_id} className="border-b border-[var(--grid)]">
              <td className="py-2 pr-4 font-mono">{c.test_case_id}</td>
              <td className="py-2 pr-4">{c.categories.map(words).join(", ") || "–"}</td>
              <td className="py-2 pr-4">{c[failedColumn] ? words(c[failedColumn]!) : "–"}</td>
              <td className="py-2 pr-4">
                <Link href={`/runs/${c.run_before}`} className="underline underline-offset-4">before</Link>
                {" · "}
                <Link href={`/runs/${c.run_after}`} className="underline underline-offset-4">after</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Compare({ searchParams }: { searchParams: Promise<{ before?: string; after?: string }> }) {
  const all = await loadVersions();
  if (all.length < 2) return <p>Comparing needs two agent versions; there {all.length === 1 ? "is one" : "are none"} so far.</p>;

  const byKey = new Map(all.map((v) => [v.agent_key, v]));
  const params = await searchParams;
  // default: the latest version against its predecessor
  const after = byKey.get(params.after ?? "") ?? all.at(-1)!;
  const before = byKey.get(params.before ?? "") ?? byKey.get(after.previous_agent_key ?? "") ?? all.at(-2)!;

  const [rates, flipped] = await Promise.all([
    categoryRates([before.agent_key, after.agent_key]),
    flippedCases(before.agent_key, after.agent_key),
  ]);
  const rateBefore = new Map(rates.filter((r) => r.agent_key === before.agent_key).map((r) => [r.category, r.pass_rate]));
  const categories = rates
    .filter((r) => r.agent_key === after.agent_key && rateBefore.has(r.category))
    .map((r) => ({ ...r, before: rateBefore.get(r.category)!, delta: r.pass_rate - rateBefore.get(r.category)! }))
    .toSorted((a, b) => a.delta - b.delta);
  const hurt = flipped.filter((c) => !c.passed_after);
  const helped = flipped.filter((c) => c.passed_after);

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-2xl font-semibold">Compare versions</h1>
        <form className="mt-4 flex flex-wrap items-end gap-3 text-sm">
          {(["before", "after"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1">
              <span className="text-[var(--ink-2)]">{side === "before" ? "Before" : "After"}</span>
              <select name={side} defaultValue={(side === "before" ? before : after).agent_key} className="rounded border border-[var(--axis)] bg-[var(--surface)] px-2 py-1">
                {all.toReversed().map((v) => <option key={v.agent_key} value={v.agent_key}>{name(v)}</option>)}
              </select>
            </label>
          ))}
          <button className="rounded border border-[var(--axis)] px-3 py-1 hover:bg-[var(--grid)]">Compare</button>
        </form>
        <p className="mt-4 text-lg">
          <span className="text-[var(--critical)]">▼ {hurt.length} newly failing</span>
          {" · "}
          <span className="text-[var(--good-text)]">▲ {helped.length} newly passing</span>
          <span className="text-[var(--ink-2)]"> of the cases both latest suite runs covered</span>
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">By test category</h2>
        <p className="text-sm text-[var(--ink-2)]">Pass rate over every run of each version, biggest drop first.</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="border-b border-[var(--grid)] text-[var(--ink-2)]">
              <tr>
                <th className="py-2 pr-4 font-medium">Category</th>
                <th className="py-2 pr-4 text-right font-medium">Before</th>
                <th className="py-2 pr-4 text-right font-medium">After</th>
                <th className="py-2 pr-4 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.category} className="border-b border-[var(--grid)]">
                  <td className="py-2 pr-4">{words(c.category)}{c.is_trap && <span className="text-[var(--muted)]"> · trap</span>}</td>
                  <td className="py-2 pr-4 text-right">{pct(c.before)}</td>
                  <td className="py-2 pr-4 text-right">{pct(c.pass_rate)}</td>
                  <td className="py-2 pr-4"><Change delta={c.delta} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-[var(--critical)]">▼ Newly failing ({hurt.length})</h2>
        <p className="text-sm text-[var(--ink-2)]">Passed in the before version&apos;s latest suite run, fail in the after version&apos;s.</p>
        <CaseTable cases={hurt} failedColumn="failed_after" />
      </section>

      <section>
        <h2 className="text-lg font-semibold text-[var(--good-text)]">▲ Newly passing ({helped.length})</h2>
        <p className="text-sm text-[var(--ink-2)]">Failed before, pass now.</p>
        <CaseTable cases={helped} failedColumn="failed_before" />
      </section>
    </div>
  );
}
