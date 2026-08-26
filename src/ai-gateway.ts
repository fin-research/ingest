import { z } from "zod";

const MAX_AI_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AI_GATEWAY_TIMEOUT_MS = 300_000;

export const AI_GATEWAY_MODEL = "gpt-5.6-luna" as const;
export const AI_GATEWAY_PRIMARY_PROVIDER = "custom-opencode" as const;
export const AI_GATEWAY_FALLBACK_PROVIDER = "custom-codex" as const;

export interface AiGatewayRunRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, never>;
  query: unknown;
}

export interface AiGatewayRunOptions {
  gateway: {
    id: string;
    skipCache: boolean;
    collectLog: boolean;
    requestTimeoutMs: number;
    retries: { maxAttempts: 1 };
    metadata: Record<string, string | number | boolean>;
  };
  signal: AbortSignal;
}

export interface AiGatewayBinding {
  aiGatewayLogId: string | null;
  gateway(gatewayId: string): {
    run(request: AiGatewayRunRequest, options: AiGatewayRunOptions): Promise<Response>;
  };
}

export interface AiGatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiGatewayOptions {
  metadata: Record<string, string | number | boolean>;
  requestTimeoutMs: number;
  reasoningEffort: "low" | "medium" | "high";
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
    super(`AI Gateway providers failed: ${failures.map((failure) => failure.provider).join(", ")}`);
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
  })
  .passthrough();

export async function generateAiGatewayObject<OUTPUT>(
  ai: AiGatewayBinding,
  gatewayId: string,
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  schemaName: string,
  options: AiGatewayOptions,
): Promise<OUTPUT> {
  const normalizedGatewayId = requiredConfig("gateway ID", gatewayId);
  const normalizedSchemaName = requiredConfig("schema name", schemaName);
  validateRequestTimeout(options.requestTimeoutMs);
  const requestSchema = z.toJSONSchema(schema);
  delete requestSchema.$schema;
  const primary = await attemptProvider(
    ai,
    normalizedGatewayId,
    AI_GATEWAY_PRIMARY_PROVIDER,
    "primary",
    messages,
    schema,
    requestSchema,
    normalizedSchemaName,
    options,
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
    ai,
    normalizedGatewayId,
    AI_GATEWAY_FALLBACK_PROVIDER,
    "fallback",
    messages,
    schema,
    requestSchema,
    normalizedSchemaName,
    options,
  );
  if (fallback.ok) return fallback.value;
  throw new AiGatewayFallbackError([
    primary.error.toFailure(),
    fallback.error.toFailure(),
  ]);
}

async function attemptProvider<OUTPUT>(
  ai: AiGatewayBinding,
  gatewayId: string,
  provider: string,
  attempt: "primary" | "fallback",
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  requestSchema: unknown,
  schemaName: string,
  options: AiGatewayOptions,
): Promise<
  | { ok: true; value: OUTPUT }
  | { ok: false; error: AiGatewayResponseError }
> {
  try {
    return {
      ok: true,
      value: await runProvider(
        ai,
        gatewayId,
        provider,
        attempt,
        messages,
        schema,
        requestSchema,
        schemaName,
        options,
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
              gatewayLogId: ai.aiGatewayLogId ?? "",
              retryable: true,
              message: error instanceof Error ? error.message : String(error),
            }),
    };
  }
}

async function runProvider<OUTPUT>(
  ai: AiGatewayBinding,
  gatewayId: string,
  provider: string,
  attempt: "primary" | "fallback",
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  requestSchema: unknown,
  schemaName: string,
  options: AiGatewayOptions,
): Promise<OUTPUT> {
  const prompt = splitInstructions(messages);
  const signal = AbortSignal.timeout(options.requestTimeoutMs + 5_000);
  const previousGatewayLogId = ai.aiGatewayLogId;
  let response: Response;
  try {
    response = await ai.gateway(gatewayId).run(
      {
        provider,
        endpoint: "responses",
        headers: {},
        query: {
          model: AI_GATEWAY_MODEL,
          ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
          input: prompt.input,
          reasoning: { effort: options.reasoningEffort },
          text: {
            format: {
              type: "json_schema",
              name: schemaName,
              strict: true,
              schema: requestSchema,
            },
          },
        },
      },
      {
        gateway: {
          id: gatewayId,
          skipCache: true,
          collectLog: true,
          requestTimeoutMs: options.requestTimeoutMs,
          retries: { maxAttempts: 1 },
          metadata: {
            ...options.metadata,
            ai_model: AI_GATEWAY_MODEL,
            ai_provider: provider,
            ai_provider_attempt: attempt,
          },
        },
        signal,
      },
    );
  } catch (error) {
    throw new AiGatewayResponseError({
      provider,
      status: null,
      gatewayLogId: changedGatewayLogId(ai, previousGatewayLogId),
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const gatewayLogId =
    changedGatewayLogId(ai, previousGatewayLogId) ||
    response.headers.get("cf-aig-log-id") ||
    "";
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
      message: responseText.trim() || "empty error response",
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
      `invalid Responses envelope: ${z.prettifyError(envelope.error)}`,
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
      `output failed business schema: ${z.prettifyError(validated.error)}`,
    );
  }
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredConfig(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`AI Gateway ${label} is not configured`);
  return normalized;
}

function validateRequestTimeout(value: number): void {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_AI_GATEWAY_TIMEOUT_MS
  ) {
    throw new Error(
      `AI Gateway request timeout must be an integer between 1 and ${MAX_AI_GATEWAY_TIMEOUT_MS}`,
    );
  }
}

function changedGatewayLogId(
  ai: AiGatewayBinding,
  previousGatewayLogId: string | null,
): string {
  return ai.aiGatewayLogId && ai.aiGatewayLogId !== previousGatewayLogId
    ? ai.aiGatewayLogId
    : "";
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
