// One client for every model provider. Ollama and most hosted providers (Kimi, Together,
// OpenRouter, ...) speak the OpenAI chat-completions API, so a provider is just a base URL
// and, for hosted ones, the env var holding its key. Providers live in models.json; a model
// is picked with a spec like "ollama/qwen3:8b", so switching provider is a config change.
import { z } from "zod";
import models from "../../models.json" with { type: "json" };

export type Provider = { base_url: string; api_key_env?: string; timeout_ms?: number };
export type ModelConfig = { providers: Record<string, Provider> };

/** A tool call the model asked for; `arguments` is the JSON text it wrote. */
export type ToolCallRequest = { id: string; name: string; arguments: string };

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCallRequest[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A tool the model may call: its name, what it does, and a JSON Schema for its arguments. */
export type ToolSpec = { name: string; description: string; parameters: object };

export type ChatOptions = {
  schema?: z.ZodType; // ask for a JSON reply of this shape; the caller still validates it
  temperature?: number;
  // OpenAI's reasoning_effort; Ollama maps it to thinking. Left out, the model decides.
  reasoning_effort?: "none" | "low" | "medium" | "high";
  tools?: ToolSpec[]; // offered to the model; any calls it makes come back in Reply.tool_calls
};

// Ollama Cloud ignores response_format and format (checked 2026-10-30: free text back from
// gpt-oss:20b and kimi-k2.6 on both its APIs), so the schema goes in the system prompt.
export const jsonInstruction = (schema: z.ZodType) =>
  "Reply with only a JSON object that matches this JSON Schema. No prose, no markdown, no code fences.\n\n" +
  JSON.stringify(z.toJSONSchema(schema));

function withSchema(messages: Message[], schema: z.ZodType): Message[] {
  const instruction = jsonInstruction(schema);
  const [first, ...rest] = messages;
  if (first?.role === "system") return [{ role: "system", content: `${first.content}\n\n${instruction}` }, ...rest];
  return [{ role: "system", content: instruction }, ...messages];
}

export type Reply = {
  text: string;
  input_tokens: number | null; // null when the provider did not report usage
  output_tokens: number | null;
  latency_ms: number;
  tool_calls: ToolCallRequest[]; // empty unless the model asked to call tools
};

/** A message as the chat-completions API expects it: tool calls nested under `function`. */
function toApi(m: Message) {
  if (m.role !== "assistant" || !m.tool_calls?.length) return m;
  return {
    role: m.role,
    content: m.content,
    tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
  };
}

export type ModelClient = {
  spec: string;
  chat: (messages: Message[], options?: ChatOptions) => Promise<Reply>;
};

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function modelClient(spec: string, config: ModelConfig = models): ModelClient {
  const slash = spec.indexOf("/"); // model names may contain more slashes, e.g. ollama/frob/ornith
  const name = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  const provider = config.providers[name];
  if (slash < 1 || !model || !provider) {
    throw new Error(`model spec "${spec}" must be <provider>/<model>, provider one of: ${Object.keys(config.providers).join(", ")}`);
  }
  const key = provider.api_key_env ? process.env[provider.api_key_env] : undefined;
  if (provider.api_key_env && !key) throw new Error(`${spec} needs ${provider.api_key_env} set`);

  async function chat(messages: Message[], options: ChatOptions = {}): Promise<Reply> {
    const body = {
      model,
      messages: (options.schema ? withSchema(messages, options.schema) : messages).map(toApi),
      temperature: options.temperature ?? 0,
      ...(options.reasoning_effort && { reasoning_effort: options.reasoning_effort }),
      ...(options.tools?.length && {
        tools: options.tools.map((t) => ({ type: "function", function: t })),
      }),
    };
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(`${provider!.base_url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(provider!.timeout_ms ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ModelError(`${spec}: request failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ModelError(`${spec}: HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status);
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const latency_ms = Math.round(performance.now() - started);
    const message = json.choices?.[0]?.message;
    const tool_calls = (message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    // a reply asking only for tool calls may have no text
    const text = typeof message?.content === "string" ? message.content : tool_calls.length ? "" : null;
    if (text === null) throw new ModelError(`${spec}: reply has no message content`, res.status);
    return {
      text,
      input_tokens: json.usage?.prompt_tokens ?? null,
      output_tokens: json.usage?.completion_tokens ?? null,
      latency_ms,
      tool_calls,
    };
  }

  return { spec, chat };
}
