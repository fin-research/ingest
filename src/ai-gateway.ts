import { z } from "zod";

const MAX_AI_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AI_GATEWAY_TIMEOUT_MS = 300_000;

export const AI_GATEWAY_MODEL = "gpt-5.6-luna" as const;
export const AI_GATEWAY_PRIMARY_PROVIDER = "custom-opencode" as const;
export const AI_GATEWAY_FALLBACK_PROVIDER = "custom-codex" as const;
export const AI_GATEWAY_REASONING_EFFORT_BY_TASK = {
  generation: "high",
  analysis: "high",
  summary: "low",
} as const;

export type AiGatewayTaskType = keyof typeof AI_GATEWAY_REASONING_EFFORT_BY_TASK;

export interface AiGatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiGatewayOptions {
  metadata: Record<string, string | number | boolean>;
  promptCacheKey: string;
  requestTimeoutMs: number;
  taskType: AiGatewayTaskType;
}

export interface AiGatewayCredentials {
  accountId: string;
  gatewayId: string;
  token: string;
}

export interface AiGatewayAttemptFailure {
  provider: string;
  status: number | null;
  gatewayLogId: string;
  retryable: boolean;
  message: string;
}

export class AiGatewayResponseError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly gatewayLogId: string;
  readonly retryable: boolean;

  constructor(failure: AiGatewayAttemptFailure) {
    super(
      `AI Gateway provider ${failure.provider} failed` +
        (failure.status === null ? "" : ` with HTTP ${failure.status}`) +
        (failure.gatewayLogId ? ` (log ${failure.gatewayLogId})` : "") +
        (failure.message ? `: ${failure.message.slice(0, 1_000)}` : ""),
    );
    this.name = "AiGatewayResponseError";
    this.provider = failure.provider;
    this.status = failure.status;
    this.gatewayLogId = failure.gatewayLogId;
    this.retryable = failure.retryable;
  }

  toFailure(): AiGatewayAttemptFailure {
    return {
      provider: this.provider,
      status: this.status,
      gatewayLogId: this.gatewayLogId,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export class AiGatewayFallbackError extends Error {
  readonly failures: readonly AiGatewayAttemptFailure[];

  constructor(failures: readonly AiGatewayAttemptFailure[]) {
    super(
      "AI Gateway providers failed: " +
        failures
          .map(
            (failure) =>
              failure.provider +
              (failure.status === null ? "" : ` HTTP ${failure.status}`) +
              (failure.gatewayLogId ? ` log ${failure.gatewayLogId}` : ""),
          )
          .join("; "),
    );
    this.name = "AiGatewayFallbackError";
    this.failures = failures;
  }
}

const responseEnvelopeSchema = z
  .object({
    status: z.enum([
      "completed",
      "failed",
      "in_progress",
      "cancelled",
      "queued",
      "incomplete",
    ]),
    output: z.array(z.unknown()),
    error: z
      .object({
        code: z.string().nullable().optional(),
        message: z.string(),
      })
      .nullable()
      .optional(),
    incomplete_details: z
      .object({ reason: z.string().optional() })
      .nullable()
      .optional(),
    prompt_cache_key: z.string().nullable().optional(),
    usage: z
      .object({
        input_tokens_details: z
          .object({
            cached_tokens: z.number().int().nonnegative().optional(),
            cache_write_tokens: z.number().int().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export async function generateAiGatewayObject<OUTPUT>(
  credentials: AiGatewayCredentials,
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  schemaName: string,
  options: AiGatewayOptions,
  fetcher: typeof fetch = fetch,
): Promise<OUTPUT> {
  const normalizedCredentials = validateCredentials(credentials);
  const normalizedSchemaName = requiredConfig("schema name", schemaName);
  const normalizedPromptCacheKey = requiredConfig(
    "prompt cache key",
    options.promptCacheKey,
  );
  validateRequestTimeout(options.requestTimeoutMs);
  const requestSchema = z.toJSONSchema(schema);
  delete requestSchema.$schema;

  const primary = await attemptProvider(
    normalizedCredentials,
    AI_GATEWAY_PRIMARY_PROVIDER,
    "primary",
    messages,
    schema,
    requestSchema,
    normalizedSchemaName,
    normalizedPromptCacheKey,
    options,
    fetcher,
  );
  if (primary.ok) return primary.value;
  if (!primary.error.retryable) throw primary.error;

  console.warn(
    JSON.stringify({
      event: "ai_gateway_fallback_started",
      provider: primary.error.provider,
      status: primary.error.status,
      gateway_log_id: primary.error.gatewayLogId,
      error: primary.error.message,
    }),
  );

  const fallback = await attemptProvider(
    normalizedCredentials,
    AI_GATEWAY_FALLBACK_PROVIDER,
    "fallback",
    messages,
    schema,
    requestSchema,
    normalizedSchemaName,
    normalizedPromptCacheKey,
    options,
    fetcher,
  );
  if (fallback.ok) return fallback.value;
  throw new AiGatewayFallbackError([
    primary.error.toFailure(),
    fallback.error.toFailure(),
  ]);
}

async function attemptProvider<OUTPUT>(
  credentials: AiGatewayCredentials,
  provider: string,
  attempt: "primary" | "fallback",
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  requestSchema: unknown,
  schemaName: string,
  promptCacheKey: string,
  options: AiGatewayOptions,
  fetcher: typeof fetch,
): Promise<
  | { ok: true; value: OUTPUT }
  | { ok: false; error: AiGatewayResponseError }
> {
  try {
    return {
      ok: true,
      value: await runProvider(
        credentials,
        provider,
        attempt,
        messages,
        schema,
        requestSchema,
        schemaName,
        promptCacheKey,
        options,
        fetcher,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof AiGatewayResponseError
          ? error
          : new AiGatewayResponseError({
              provider,
              status: null,
              gatewayLogId: "",
              retryable: true,
              message: error instanceof Error ? error.message : String(error),
            }),
    };
  }
}

async function runProvider<OUTPUT>(
  credentials: AiGatewayCredentials,
  provider: string,
  attempt: "primary" | "fallback",
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  requestSchema: unknown,
  schemaName: string,
  promptCacheKey: string,
  options: AiGatewayOptions,
  fetcher: typeof fetch,
): Promise<OUTPUT> {
  const prompt = splitInstructions(messages);
  const reasoningEffort = AI_GATEWAY_REASONING_EFFORT_BY_TASK[options.taskType];
  const url =
    `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(credentials.accountId)}/` +
    `${encodeURIComponent(credentials.gatewayId)}/${encodeURIComponent(provider)}/responses`;
  const metadata = {
    ...options.metadata,
    ai_model: AI_GATEWAY_MODEL,
    ai_provider: provider,
    ai_provider_attempt: attempt,
  };

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${credentials.token}`,
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "true",
        "cf-aig-request-timeout": String(options.requestTimeoutMs),
        "cf-aig-metadata": JSON.stringify(metadata),
      },
      body: JSON.stringify({
        model: AI_GATEWAY_MODEL,
        prompt_cache_key: promptCacheKey,
        ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
        reasoning: {
          effort: reasoningEffort,
          summary: "auto",
          context: "current_turn",
        },
        text: {
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema: requestSchema,
          },
        },
        input: prompt.input,
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs + 5_000),
    });
  } catch (error) {
    throw new AiGatewayResponseError({
      provider,
      status: null,
      gatewayLogId: "",
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const gatewayLogId = response.headers.get("cf-aig-log-id") ?? "";
  let responseText: string;
  try {
    responseText = await readTextBounded(response, MAX_AI_GATEWAY_RESPONSE_BYTES);
  } catch (error) {
    throw new AiGatewayResponseError({
      provider,
      status: response.status,
      gatewayLogId,
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    throw new AiGatewayResponseError({
      provider,
      status: response.status,
      gatewayLogId,
      retryable:
        response.status === 408 || response.status === 429 || response.status >= 500,
      message: summarizeErrorResponse(responseText),
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw outputError(provider, response.status, gatewayLogId, "response body is not JSON");
  }
  const envelope = responseEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw outputError(
      provider,
      response.status,
      gatewayLogId,
      `invalid Responses envelope: ${schemaErrorSummary(envelope.error)}`,
    );
  }
  if (envelope.data.status !== "completed") {
    const details =
      envelope.data.error?.message ??
      envelope.data.incomplete_details?.reason ??
      `Responses status ${envelope.data.status}`;
    throw outputError(provider, response.status, gatewayLogId, details);
  }
  const outputText = extractOutputText(envelope.data.output);
  if (!outputText.trim()) {
    throw outputError(provider, response.status, gatewayLogId, "Responses output_text is empty");
  }

  let output: unknown;
  try {
    output = JSON.parse(outputText);
  } catch {
    throw outputError(provider, response.status, gatewayLogId, "output_text is not JSON");
  }
  const validated = schema.safeParse(output);
  if (!validated.success) {
    throw outputError(
      provider,
      response.status,
      gatewayLogId,
      `output failed business schema: ${schemaErrorSummary(validated.error)}`,
    );
  }
  const reasoningSummary = reasoningSummaryMetrics(envelope.data.output);
  console.log(
    JSON.stringify({
      event: "ai_gateway_provider_succeeded",
      provider,
      provider_attempt: attempt,
      model: AI_GATEWAY_MODEL,
      task_type: options.taskType,
      reasoning_effort: reasoningEffort,
      requested_reasoning_summary: "auto",
      requested_reasoning_context: "current_turn",
      reasoning_summary_count: reasoningSummary.count,
      reasoning_summary_text_length: reasoningSummary.textLength,
      prompt_cache_key: envelope.data.prompt_cache_key ?? promptCacheKey,
      cached_input_tokens:
        envelope.data.usage?.input_tokens_details?.cached_tokens ?? null,
      cache_write_input_tokens:
        envelope.data.usage?.input_tokens_details?.cache_write_tokens ?? null,
      encrypted_reasoning_present: hasEncryptedReasoning(envelope.data.output),
      output_text_length: outputText.length,
      status: response.status,
      gateway_log_id: gatewayLogId,
    }),
  );
  return validated.data;
}

function splitInstructions(messages: AiGatewayMessage[]): {
  instructions: string | undefined;
  input: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input = messages.filter(
    (message): message is { role: "user" | "assistant"; content: string } =>
      message.role !== "system",
  );
  return { instructions: instructions || undefined, input };
}

function extractOutputText(output: unknown[]): string {
  const texts: string[] = [];
  for (const item of output) {
    if (!isObject(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isObject(content) && content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }
  return texts.join("");
}

function hasEncryptedReasoning(output: unknown[]): boolean {
  return output.some(
    (item) =>
      isObject(item) &&
      item.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0,
  );
}

function reasoningSummaryMetrics(output: unknown[]): {
  count: number;
  textLength: number;
} {
  let count = 0;
  let textLength = 0;
  for (const item of output) {
    if (!isObject(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) {
      continue;
    }
    for (const summary of item.summary) {
      if (
        !isObject(summary) ||
        summary.type !== "summary_text" ||
        typeof summary.text !== "string"
      ) {
        continue;
      }
      count += 1;
      textLength += summary.text.length;
    }
  }
  return { count, textLength };
}

function outputError(
  provider: string,
  status: number,
  gatewayLogId: string,
  message: string,
): AiGatewayResponseError {
  return new AiGatewayResponseError({
    provider,
    status,
    gatewayLogId,
    retryable: true,
    message,
  });
}

function summarizeErrorResponse(text: string): string {
  if (!text.trim()) return "empty error response";
  try {
    const payload = JSON.parse(text) as unknown;
    if (!isObject(payload)) return "non-success response";
    const error = payload.error;
    if (typeof error === "string") return error.slice(0, 500);
    if (isObject(error) && typeof error.message === "string") {
      return error.message.slice(0, 500);
    }
    if (typeof payload.message === "string") return payload.message.slice(0, 500);
  } catch {
    return "non-JSON error response";
  }
  return "non-success response";
}

function schemaErrorSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCredentials(credentials: AiGatewayCredentials): AiGatewayCredentials {
  return {
    accountId: requiredConfig("account ID", credentials.accountId),
    gatewayId: requiredConfig("gateway ID", credentials.gatewayId),
    token: requiredConfig("authentication token", credentials.token),
  };
}

function requiredConfig(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`AI Gateway ${label} is not configured`);
  return normalized;
}

function validateRequestTimeout(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_AI_GATEWAY_TIMEOUT_MS) {
    throw new Error(
      `AI Gateway request timeout must be an integer between 1 and ${MAX_AI_GATEWAY_TIMEOUT_MS}`,
    );
  }
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
