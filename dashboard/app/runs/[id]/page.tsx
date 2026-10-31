import Link from "next/link";
import { notFound } from "next/navigation";
import { alignment } from "harness/scorers";
import type { GroundTruth } from "harness/ground-truth";
import type { Summary, ToolCall } from "shared-types";
import { runTrace } from "@/lib/db";

export const dynamic = "force-dynamic";

const words = (s: string) => s.replaceAll("_", " ");
const plain = (s: string) => s.replace(/\s*\([^)]*\)$/, "");
const tint = (color: string, pct: number) => `color-mix(in srgb, var(${color}) ${pct}%, transparent)`;

type Mark = "missed" | "found";

/** The note with each record item highlighted where its name appears: missed in red, found in blue. */
function HighlightedNote({ note, terms }: { note: string; terms: { text: string; mark: Mark }[] }) {
  const lower = note.toLowerCase();
  const spans: { start: number; end: number; mark: Mark }[] = [];
  for (const { text, mark } of terms) {
    const needle = text.toLowerCase();
    for (let at = lower.indexOf(needle); needle && at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      spans.push({ start: at, end: at + needle.length, mark });
    }
  }
  // longest first, so "Tree pollen" wins over "pollen"; skip spans overlapping one kept
  const kept: typeof spans = [];
  for (const s of spans.toSorted((a, b) => b.end - b.start - (a.end - a.start))) {
    if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  kept.sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const s of kept) {
    parts.push(note.slice(at, s.start));
    parts.push(
      <mark
        key={s.start}
        title={s.mark === "missed" ? "On the record, missing from the summary" : "On the record, in the summary"}
        style={{ background: tint(s.mark === "missed" ? "--critical" : "--series-1", s.mark === "missed" ? 28 : 16), color: "inherit" }}
        className={`rounded px-0.5 ${s.mark === "missed" ? "font-semibold underline decoration-2" : ""}`}
      >
        {note.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  parts.push(note.slice(at));
  return <pre className="whitespace-pre-wrap font-sans text-sm leading-6">{parts}</pre>;
}

function Item({ ok, okText, badText, children }: { ok: boolean | null; okText: string; badText: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2 py-1">
      <span className={`w-28 shrink-0 text-xs font-semibold ${ok === null ? "text-[var(--muted)]" : ok ? "text-[var(--good-text)]" : "text-[var(--critical)]"}`}>
        {ok === null ? "– ignored" : ok ? `✓ ${okText}` : `✗ ${badText}`}
      </span>
      <span>{children}</span>
    </li>
  );
}

export default async function Run({ params }: { params: Promise<{ id: string }> }) {
  const run = await runTrace((await params).id);
  if (!run) notFound();

  const truth: GroundTruth = JSON.parse(run.ground_truth);
  const summary: Summary | null = run.parsed_output ? JSON.parse(run.parsed_output) : null;
  const toolCalls: ToolCall[] = JSON.parse(run.tool_calls);
  const al = summary && alignment(summary, truth);
  const failed = run.scores.filter((s) => !s.passed);
  const judge = run.scores.filter((s) => s.scorer.startsWith("judge_"));

  const terms = al
    ? [
        ...al.allergies.record.map((a) => ({ text: a.substance, mark: (a.found ? "found" : "missed") as Mark })),
        ...al.medications.record.map((m) => ({ text: m.name, mark: (m.found ? "found" : "missed") as Mark })),
      ]
    : [];

  return (
    <div className="space-y-8">
      <section>
        <p className="text-sm text-[var(--ink-2)]">
          Agent {run.agent_version}, prompt {run.prompt_version} · {run.agent_model} · {run.created_at} · suite {run.suite_run_id}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">
          <span className="font-mono">{run.test_case_id}</span>{" "}
          {run.passed ? <span className="text-[var(--good-text)]">✓ passed</span> : <span className="text-[var(--critical)]">✗ failed</span>}
        </h1>
        <p className="mt-1 text-sm text-[var(--ink-2)]">Categories: {run.categories.map(words).join(", ") || "none"}</p>
      </section>

      {(failed.length > 0 || run.error_stage) && (
        <section className="rounded-lg border p-4" style={{ borderColor: tint("--critical", 50), background: tint("--critical", 6) }}>
          <h2 className="font-semibold text-[var(--critical)]">What went wrong</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {run.error_stage && <li><strong>{run.error_stage} error:</strong> {run.error_message}</li>}
            {failed.map((s) => (
              <li key={s.scorer}><strong>{words(s.scorer)}</strong> ({Math.round(s.value * 100)}%): {s.detail}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-semibold">Note</h2>
          <p className="mb-3 text-xs text-[var(--ink-2)]">
            Record items highlighted: <mark style={{ background: tint("--critical", 28), color: "inherit" }} className="rounded px-0.5 font-semibold underline decoration-2">missed</mark>{" "}
            <mark style={{ background: tint("--series-1", 16), color: "inherit" }} className="rounded px-0.5">found</mark>
          </p>
          <div className="rounded-lg border border-[var(--grid)] p-4"><HighlightedNote note={run.note} terms={terms} /></div>
        </section>

        <section className="space-y-6 text-sm">
          {!al ? (
            <p>No summary to compare: the run failed before one was parsed.</p>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-semibold">Allergies</h2>
                <h3 className="mt-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">On the record</h3>
                <ul>
                  {al.allergies.record.length === 0 && <li className="py-1 text-[var(--muted)]">None</li>}
                  {al.allergies.record.map((a) => (
                    <Item key={a.substance} ok={a.found} okText="found" badText="missed">
                      {a.substance}{a.reactions.length > 0 && <span className="text-[var(--ink-2)]"> · {a.reactions.map((r) => plain(r.manifestation)).join(", ")}</span>}
                    </Item>
                  ))}
                </ul>
                <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">In the summary</h3>
                <ul>
                  {al.allergies.summary.length === 0 && <li className="py-1 text-[var(--muted)]">None</li>}
                  {al.allergies.summary.map((a, i) => (
                    <Item key={i} ok={a.placeholder ? null : a.onRecord} okText="on record" badText="not on record">{a.substance}</Item>
                  ))}
                </ul>
              </div>

              <div>
                <h2 className="text-lg font-semibold">Medications</h2>
                <h3 className="mt-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">On the record</h3>
                <ul>
                  {al.medications.record.map((m, i) => (
                    <Item key={i} ok={m.found} okText="found" badText="missed">
                      {m.name}
                      {m.dose !== null && <span className="text-[var(--ink-2)]"> · {m.dose} per dose</span>}
                      {m.as_needed && <span className="text-[var(--ink-2)]"> · as needed</span>}
                      {m.timing && <span className="text-[var(--ink-2)]"> · {m.timing.frequency}× per {m.timing.period} {m.timing.period_unit}</span>}
                    </Item>
                  ))}
                </ul>
                <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">In the summary</h3>
                <ul>
                  {al.medications.summary.map((m, i) => (
                    <Item key={i} ok={m.onRecord} okText="on record" badText="not on record">
                      {m.name}
                      <span className="text-[var(--ink-2)]"> · {m.dose ?? "no dose"} · {m.frequency ?? "no frequency"}</span>
                    </Item>
                  ))}
                </ul>
              </div>

              <div>
                <h2 className="text-lg font-semibold">Conditions</h2>
                <p className="text-xs text-[var(--ink-2)]">Graded by the judge, not string matching.</p>
                <div className="mt-2 grid grid-cols-2 gap-4">
                  <ul><li className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">On the record</li>{truth.conditions.map((c) => <li key={c.code} className="py-0.5">{plain(c.name)}</li>)}</ul>
                  <ul><li className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">In the summary</li>{summary!.conditions.map((c, i) => <li key={i} className="py-0.5">{c}</li>)}</ul>
                </div>
              </div>

              <div>
                <h2 className="text-lg font-semibold">Narrative</h2>
                <p className="mt-1">{summary!.narrative}</p>
              </div>
            </>
          )}
        </section>
      </div>

      {judge.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Judge</h2>
          <p className="text-xs text-[var(--ink-2)]">{run.judge_model}, prompt {run.judge_prompt_version}</p>
          <ul className="mt-2 space-y-2 text-sm">
            {judge.map((s) => (
              <li key={s.scorer}>
                <span className={`font-semibold ${s.passed ? "text-[var(--good-text)]" : "text-[var(--critical)]"}`}>{s.passed ? "✓" : "✗"} {words(s.scorer.replace("judge_", ""))}</span>{" "}
                {s.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="text-sm">
        <h2 className="text-lg font-semibold">Run</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <dt className="text-[var(--ink-2)]">Latency</dt><dd>{(run.latency_ms / 1000).toFixed(1)} s</dd>
          <dt className="text-[var(--ink-2)]">Tokens in / out</dt><dd>{run.input_tokens ?? "–"} / {run.output_tokens ?? "–"}</dd>
          <dt className="text-[var(--ink-2)]">Tool calls</dt><dd>{toolCalls.length}</dd>
          <dt className="text-[var(--ink-2)]">Run id</dt><dd className="font-mono text-xs">{run.run_id}</dd>
        </dl>
        {toolCalls.length > 0 && (
          <ol className="mt-3 list-decimal space-y-1 pl-5">
            {toolCalls.map((t, i) => (
              <li key={i}><span className="font-mono">{t.name}</span> ({t.latency_ms} ms): <code className="text-xs">{JSON.stringify(t.input)}</code> → <code className="text-xs">{JSON.stringify(t.output)}</code></li>
            ))}
          </ol>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-[var(--ink-2)]">Raw model output</summary>
          <pre className="mt-2 overflow-x-auto rounded border border-[var(--grid)] p-3 text-xs">{run.raw_output ?? "(none)"}</pre>
        </details>
      </section>

      <p className="text-sm"><Link href="/compare" className="underline underline-offset-4">← Compare versions</Link></p>
    </div>
  );
}
