// Against the real agent and judge models in models.json. Skipped when their provider's
// key is not set (as in CI), so `make check` makes two small paid calls when it is.
import { expect, test } from "bun:test";
import { z } from "zod";
import models from "../../models.json" with { type: "json" };
import { modelClient, type ModelConfig } from "./model";

const config: ModelConfig = models;

for (const role of ["agent", "judge"] as const) {
  const spec = models[role];
  const provider = config.providers[spec.split("/")[0]!];
  const missingKey = provider?.api_key_env !== undefined && !process.env[provider.api_key_env];

  test.skipIf(missingKey)(`${role} model ${spec} answers in the requested shape with token counts`, async () => {
    const schema = z.strictObject({ medications: z.array(z.string()) });
    const reply = await modelClient(spec).chat(
      [{ role: "user", content: "Patient takes lisinopril 10 mg daily. List the medications." }],
      { schema },
    );
    expect(schema.parse(JSON.parse(reply.text)).medications.join(" ").toLowerCase()).toContain("lisinopril");
    expect(reply.input_tokens).toBeGreaterThan(0);
    expect(reply.output_tokens).toBeGreaterThan(0);
    expect(reply.latency_ms).toBeGreaterThan(0);
  }, 120_000);
}
