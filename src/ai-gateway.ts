import { Output, generateText, type FlexibleSchema } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const MAX_AI_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;

export const DYNAMIC_ROUTE_MODEL = "dynamic/rag" as const;
export const DYNAMIC_ROUTE_TEMPERATURE = 0.1 as const;

export interface DynamicRouteMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DynamicRouteOptions {
  metadata: Record<string, string | number | boolean>;
  requestTimeoutMs: number;
  maxRetries: number;
  reasoningEffort: "low" | "high";
  enableThinking: boolean;
}

export interface AiGatewayCredentials {
  accountId: string;
  gatewayId: string;
  token: string;
}

export class AiGatewayResponseError extends Error {
  readonly status: number;
  readonly gatewayLogId: string;

  constructor(status: number, gatewayLogId: string, details: string) {
    super(
      `AI Gateway request failed with HTTP ${status}` +
        (gatewayLogId ? ` (log ${gatewayLogId})` : "") +
        (details ? `: ${details.slice(0, 1_000)}` : ""),
    );
    this.status = status;
    this.gatewayLogId = gatewayLogId;
    this.name = "AiGatewayResponseError";
  }
}

export async function generateDynamicRouteText(
  credentials: AiGatewayCredentials,
  messages: DynamicRouteMessage[],
  options: DynamicRouteOptions,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const prompt = splitInstructions(messages);
  const result = await generateText({
    model: dynamicRouteModel(credentials, options, fetcher),
    instructions: prompt.instructions,
    messages: prompt.messages,
    temperature: DYNAMIC_ROUTE_TEMPERATURE,
    maxRetries: options.maxRetries,
    abortSignal: AbortSignal.timeout(options.requestTimeoutMs + 5_000),
    output: Output.text(),
  });
  return result.output;
}

export async function generateDynamicRouteObject<OUTPUT>(
  credentials: AiGatewayCredentials,
  messages: DynamicRouteMessage[],
  schema: FlexibleSchema<OUTPUT>,
  schemaName: string,
  options: DynamicRouteOptions,
  fetcher: typeof fetch = fetch,
): Promise<OUTPUT> {
  const prompt = splitInstructions(messages);
  const result = await generateText({
    model: dynamicRouteModel(credentials, options, fetcher),
    instructions: prompt.instructions,
    messages: prompt.messages,
    temperature: DYNAMIC_ROUTE_TEMPERATURE,
    maxRetries: options.maxRetries,
    abortSignal: AbortSignal.timeout(options.requestTimeoutMs + 5_000),
    output: Output.object({ schema, name: schemaName }),
  });
  return result.output;
}

function splitInstructions(messages: DynamicRouteMessage[]): {
  instructions: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const conversation = messages.filter(
    (message): message is { role: "user" | "assistant"; content: string } =>
      message.role !== "system",
  );
  return { instructions: instructions || undefined, messages: conversation };
}

function dynamicRouteModel(
  credentials: AiGatewayCredentials,
  options: DynamicRouteOptions,
  fetcher: typeof fetch,
) {
  const accountId = requiredConfig("account ID", credentials.accountId);
  const gatewayId = requiredConfig("gateway ID", credentials.gatewayId);
  const token = requiredConfig("authentication token", credentials.token);
  const provider = createOpenAICompatible({
    name: "cloudflareDynamicRoute",
    baseURL:
      `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/` +
      `${encodeURIComponent(gatewayId)}/compat`,
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log": "true",
      "cf-aig-request-timeout": String(options.requestTimeoutMs),
      "cf-aig-metadata": JSON.stringify(options.metadata),
    },
    supportsStructuredOutputs: true,
    transformRequestBody: (body) => ({
      ...body,
      reasoning_effort: options.reasoningEffort,
      chat_template_kwargs: { enable_thinking: options.enableThinking },
    }),
    fetch: async (input, init) => await boundedGatewayFetch(input, init, fetcher),
  });
  return provider.chatModel(DYNAMIC_ROUTE_MODEL);
}

async function boundedGatewayFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fetcher: typeof fetch,
): Promise<Response> {
  const response = await fetcher(input, init);
  const text = await readTextBounded(response, MAX_AI_GATEWAY_RESPONSE_BYTES);
  const gatewayLogId = response.headers.get("cf-aig-log-id") ?? "";
  if (!response.ok) {
    throw new AiGatewayResponseError(response.status, gatewayLogId, text.trim());
  }
  if (!text.trim()) {
    throw new AiGatewayResponseError(
      response.status,
      gatewayLogId,
      "empty response body",
    );
  }
  return new Response(normalizeChatCompletion(text), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeChatCompletion(text: string): string {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(payload.choices)) return text;
    let changed = false;
    const choices = payload.choices.map((choice) => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
      const row = choice as Record<string, unknown>;
      const message = row.message;
      if (
        row.finish_reason !== null ||
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        typeof (message as Record<string, unknown>).content !== "string"
      ) {
        return choice;
      }
      changed = true;
      return { ...row, finish_reason: "stop" };
    });
    return changed ? JSON.stringify({ ...payload, choices }) : text;
  } catch {
    return text;
  }
}

function requiredConfig(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`AI Gateway ${label} is not configured`);
  return normalized;
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`AI Gateway response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("AI Gateway response too large");
      throw new Error(`AI Gateway response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
