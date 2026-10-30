// Server-rendered SVG charts. Hover tooltips are native <title> elements, so the charts
// need no client JavaScript. ponytail: hand-written SVG instead of Recharts for two
// charts; switch if a chart needs zoom, brushing or animated transitions.
import type { CategoryRate, Version } from "@/lib/db";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const label = (v: Version) => `agent ${v.agent_version} · prompt ${v.prompt_version}`;

/** Pass rate per version, oldest to newest. One series, so the title names it and there is no legend. */
export function PassRateLine({ versions }: { versions: Version[] }) {
  const W = 640, H = 220, left = 44, right = 56, top = 12, bottom = 28;
  const x = (i: number) => left + (versions.length === 1 ? (W - left - right) / 2 : (i * (W - left - right)) / (versions.length - 1));
  const y = (rate: number) => top + (1 - rate) * (H - top - bottom);
  const points = versions.map((v, i) => `${x(i)},${y(v.pass_rate)}`).join(" ");
  const last = versions.at(-1)!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Pass rate by agent version, oldest to newest">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
          <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular-nums">{pct(t)}</text>
        </g>
      ))}
      <polyline points={points} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
      {versions.map((v, i) => (
        <g key={v.agent_key}>
          <circle cx={x(i)} cy={y(v.pass_rate)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          {/* a bigger invisible target carries the tooltip */}
          <circle cx={x(i)} cy={y(v.pass_rate)} r={12} fill="transparent">
            <title>{`${label(v)}\n${v.agent_model}\nfirst run ${v.first_run_at}\npass rate ${pct(v.pass_rate)} over ${v.run_count} runs`}</title>
          </circle>
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">v{i + 1}</text>
        </g>
      ))}
      <text x={x(versions.length - 1) + 10} y={y(last.pass_rate)} dy="0.32em" fontSize={12} fontWeight={600} fill="var(--ink)">{pct(last.pass_rate)}</text>
    </svg>
  );
}

/** Horizontal bar with only its data end rounded (4px); the baseline end stays square. */
function bar(x0: number, y0: number, w: number, h: number) {
  const r = Math.min(4, w, h / 2);
  return `M${x0},${y0} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z`;
}

/** Pass rate per test category for one version, worst first, with the predecessor's rate as a tick. */
export function CategoryBars({ rates, previous }: { rates: CategoryRate[]; previous: CategoryRate[] }) {
  const sorted = rates.toSorted((a, b) => a.pass_rate - b.pass_rate);
  const before = new Map(previous.map((r) => [r.category, r.pass_rate]));
  const W = 640, left = 130, right = 124, row = 28, barH = 16, top = 4;
  const H = top + sorted.length * row + 20;
  const x = (rate: number) => left + rate * (W - left - right);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Pass rate by test category">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top} y2={H - 20} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
          <text x={x(t)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">{pct(t)}</text>
        </g>
      ))}
      {sorted.map((r, i) => {
        const cy = top + i * row + row / 2;
        const prev = before.get(r.category);
        const tip = `${r.category.replaceAll("_", " ")}${r.is_trap ? " (trap)" : ""}: ${pct(r.pass_rate)} of ${r.run_count} runs` +
          (prev === undefined ? "" : `\nprevious version: ${pct(prev)}`);
        return (
          <g key={r.category}>
            <text x={left - 10} y={cy} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--ink-2)">{r.category.replaceAll("_", " ")}</text>
            {r.pass_rate > 0 && <path d={bar(x(0), cy - barH / 2, x(r.pass_rate) - x(0), barH)} fill="var(--series-1)" />}
            {prev !== undefined && <line x1={x(prev)} x2={x(prev)} y1={cy - barH / 2 - 3} y2={cy + barH / 2 + 3} stroke="var(--ink)" strokeWidth={2} />}
            <text x={x(Math.max(r.pass_rate, prev ?? 0)) + 6} y={cy} dy="0.32em" fontSize={12} fill="var(--ink)" className="tabular-nums">
              {pct(r.pass_rate)}
              {prev !== undefined && pct(prev) !== pct(r.pass_rate) && <tspan fill="var(--muted)">{` · was ${pct(prev)}`}</tspan>}
            </text>
            <rect x={0} y={cy - row / 2} width={W} height={row} fill="transparent"><title>{tip}</title></rect>
          </g>
        );
      })}
    </svg>
  );
}
