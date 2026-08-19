const MAX_AI_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface DynamicRouteOptions {
  metadata: Record<string, string | number | boolean>;
  requestTimeoutMs: number;
}

export interface AiGatewayCredentials {
  accountId: string;
  gatewayId: string;
  token: string;
}

export class AiGatewayResponseError extends Error {
  readonly status: number;
  readonly gatewayLogId: string;

  constructor(
    status: number,
    gatewayLogId: string,
    details: string,
  ) {
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

export async function runDynamicRoute(
  credentials: AiGatewayCredentials,
  query: Record<string, unknown>,
  options: DynamicRouteOptions,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const accountId = requiredConfig("account ID", credentials.accountId);
  const gatewayId = requiredConfig("gateway ID", credentials.gatewayId);
  const token = requiredConfig("authentication token", credentials.token);
  const response = await fetcher(
    `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/compat/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${token}`,
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "true",
        "cf-aig-request-timeout": String(options.requestTimeoutMs),
        "cf-aig-metadata": JSON.stringify(options.metadata),
      },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(options.requestTimeoutMs + 5_000),
    },
  );
  const text = await readTextBounded(response, MAX_AI_GATEWAY_RESPONSE_BYTES);
  const gatewayLogId = response.headers.get("cf-aig-log-id") ?? "";
  if (!response.ok) {
    throw new AiGatewayResponseError(response.status, gatewayLogId, text.trim());
  }
  if (!text.trim()) {
    throw new AiGatewayResponseError(response.status, gatewayLogId, "empty response body");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiGatewayResponseError(response.status, gatewayLogId, "response body is not valid JSON");
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
