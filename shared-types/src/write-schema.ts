// Regenerate schemas/trace_event.schema.json from the zod schema.
import { traceEventJsonSchema } from "./index";

export const schemaPath = `${import.meta.dir}/../../schemas/trace_event.schema.json`;
export const schemaText = () => JSON.stringify(traceEventJsonSchema(), null, 2) + "\n";

if (import.meta.main) {
  await Bun.write(schemaPath, schemaText());
  console.log(`wrote ${schemaPath}`);
}
