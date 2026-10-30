// Run the summariser on test cases and print what it produced.
//   bun run agent                 the first 5 cases
//   bun run agent v1-006 v1-012   these cases
// ponytail: prints only; scoring and trace files come with the suite runner (KAN-19)
import models from "../../models.json" with { type: "json" };
import { modelClient } from "./model";
import { summarise } from "./summarise";

const DATASET = `${import.meta.dir}/../../datasets/notes_v1.jsonl`;

type Case = { case_id: string; categories: string[]; note: string };

const text = await Bun.file(DATASET).text().catch(() => {
  console.error(`${DATASET} not found; build it with: uv run --project data_processing ai-health-harness`);
  process.exit(1);
});
const cases: Case[] = text.trim().split("\n").map((line) => JSON.parse(line));
const wanted = process.argv.slice(2);
const picked = wanted.length ? cases.filter((c) => wanted.includes(c.case_id)) : cases.slice(0, 5);
const unknown = wanted.filter((id) => !cases.some((c) => c.case_id === id));
if (unknown.length) {
  console.error(`unknown case ids: ${unknown.join(", ")}`);
  process.exit(1);
}

const client = modelClient(models.agent);
for (const c of picked) {
  const run = await summarise(c.note, client);
  console.log(`=== ${c.case_id} [${c.categories.join(", ") || "-"}] ${run.latency_ms} ms, ${run.input_tokens} in / ${run.output_tokens} out`);
  console.log(run.error ? `ERROR (${run.error.stage}): ${run.error.message}` : JSON.stringify(run.parsed_output, null, 2));
}
