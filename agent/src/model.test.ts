import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { ModelError, jsonInstruction, modelClient, type ModelConfig } from "./model";

// A stand-in provider: a real HTTP server that records each request and replies as told.
let reply: () => Response = () => Response.json({});
const seen: { url: string; headers: Headers; body: any }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push({ url: req.url, headers: req.headers, body: await req.json() });
    return reply();
  },
});
afterAll(() => server.stop(true));

const base = `http://localhost:${server.port}/v1`;
const config: ModelConfig = {
  providers: {
    local: { base_url: base },
    hosted: { base_url: base, api_key_env: "TEST_MODEL_KEY" },
    slow: { base_url: base, timeout_ms: 50 },
  },
};
const ok = (content: string, usage?: object) => () => Response.json({ choices: [{ message: { content } }], usage });

test("sends an OpenAI-style request and returns text, tokens and latency", async () => {
  reply = ok("hello", { prompt_tokens: 12, completion_tokens: 3 });
  const result = await modelClient("local/qwen3:8b", config).chat([{ role: "user", content: "hi" }]);
  expect(result).toMatchObject({ text: "hello", input_tokens: 12, output_tokens: 3 });
  expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  const req = seen.at(-1)!;
  expect(req.url).toBe(`${base}/chat/completions`);
  expect(req.body).toEqual({ model: "qwen3:8b", messages: [{ role: "user", content: "hi" }], temperature: 0 });
  expect(req.headers.get("authorization")).toBeNull();
});

test("reasoning effort is sent only when asked for", async () => {
  reply = ok("hello");
  await modelClient("local/qwen3:8b", config).chat([{ role: "user", content: "hi" }], { reasoning_effort: "none" });
  expect(seen.at(-1)!.body).toMatchObject({ reasoning_effort: "none" });
});

test("a schema goes into the system prompt, merged with any system prompt already there", async () => {
  reply = ok('{"meds":[]}');
  const schema = z.strictObject({ meds: z.array(z.string()) });
  const instruction = jsonInstruction(schema);
  expect(instruction).toContain('"required":["meds"]');
  const client = modelClient("local/m", config);

  await client.chat([{ role: "user", content: "x" }], { schema });
  expect(seen.at(-1)!.body.messages).toEqual([
    { role: "system", content: instruction },
    { role: "user", content: "x" },
  ]);

  await client.chat([{ role: "system", content: "You summarise notes." }, { role: "user", content: "x" }], { schema });
  expect(seen.at(-1)!.body.messages).toEqual([
    { role: "system", content: `You summarise notes.\n\n${instruction}` },
    { role: "user", content: "x" },
  ]);
  expect(seen.at(-1)!.body.response_format).toBeUndefined();
});

test("model names keep their slashes", async () => {
  reply = ok("x");
  await modelClient("local/frob/ornith-1.5:9b-mlx", config).chat([]);
  expect(seen.at(-1)!.body.model).toBe("frob/ornith-1.5:9b-mlx");
});

test("hosted providers send the key from their env var, and refuse to start without it", async () => {
  delete process.env.TEST_MODEL_KEY;
  expect(() => modelClient("hosted/kimi-k2", config)).toThrow("needs TEST_MODEL_KEY set");
  process.env.TEST_MODEL_KEY = "sk-test";
  reply = ok("x");
  await modelClient("hosted/kimi-k2", config).chat([]);
  expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer sk-test");
});

test("bad specs name the known providers", () => {
  for (const spec of ["qwen3", "/qwen3", "local/", "nope/qwen3"]) {
    expect(() => modelClient(spec, config)).toThrow("provider one of: local, hosted, slow");
  }
});

test("missing usage gives null token counts", async () => {
  reply = ok("x");
  expect(await modelClient("local/m", config).chat([])).toMatchObject({ input_tokens: null, output_tokens: null });
});

test("failures throw ModelError: HTTP errors, empty replies, timeouts, unreachable hosts", async () => {
  const client = modelClient("local/m", config);
  reply = () => new Response("model not found", { status: 404 });
  const http = await client.chat([]).catch((e) => e);
  expect(http).toBeInstanceOf(ModelError);
  expect(http.status).toBe(404);
  expect(http.message).toContain("model not found");

  reply = () => Response.json({ choices: [] });
  await expect(client.chat([])).rejects.toThrow("no message content");

  reply = ok("late");
  const slow = Bun.serve({ port: 0, fetch: () => Bun.sleep(500).then(() => new Response("{}")) });
  const timeout = { providers: { slow: { base_url: `http://localhost:${slow.port}/v1`, timeout_ms: 50 } } };
  await expect(modelClient("slow/m", timeout).chat([])).rejects.toBeInstanceOf(ModelError);
  slow.stop(true);

  const gone = { providers: { gone: { base_url: "http://localhost:1/v1" } } };
  await expect(modelClient("gone/m", gone).chat([])).rejects.toThrow("request failed");
});
