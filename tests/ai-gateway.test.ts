import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AI_GATEWAY_REASONING_EFFORT_BY_TASK,
  AiGatewayFallbackError,
  AiGatewayResponseError,
  generateAiGatewayObject,
} from "../src/ai-gateway";

const credentials = {
  accountId: "account-id",
  gatewayId: "default",
  token: "test-token",
};

const options = {
  promptCacheKey: "article-features:v5",
  requestTimeoutMs: 120_000,
  taskType: "summary" as const,
  metadata: { article_id: "A001", prompt_version: "v5" },
};

function responsesOutput(value: unknown, status = "completed"): Response {
  return Response.json({
    id: "resp-test",
    object: "response",
    status,
    prompt_cache_key: "article-features:v5",
    usage: {
      input_tokens_details: { cached_tokens: 1_024, cache_write_tokens: 0 },
    },
    output: [
      {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "Reviewed the available evidence." },
        ],
        encrypted_content: "encrypted-reasoning",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  });
}

describe("AI Gateway provider-specific Responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls custom-opencode directly with Gateway auth and one strict JSON Schema", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return responsesOutput({ ok: true });
    };

    const output = await generateAiGatewayObject(
      credentials,
      [
        { role: "system", content: "system" },
        { role: "user", content: "test" },
      ],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    );

    expect(output).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-opencode/responses",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer test-token");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expect(headers.get("cf-aig-request-timeout")).toBe("120000");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "null")).toEqual({
      article_id: "A001",
      prompt_version: "v5",
      ai_model: "gpt-5.6-luna",
      ai_provider: "custom-opencode",
      ai_provider_attempt: "primary",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "gpt-5.6-luna",
      prompt_cache_key: "article-features:v5",
      instructions: "system",
      reasoning: {
        effort: "low",
        summary: "auto",
        context: "current_turn",
      },
      text: {
        format: {
          type: "json_schema",
          name: "probe",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
      input: [{ role: "user", content: "test" }],
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).not.toHaveProperty("include");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"provider":"custom-opencode"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"requested_reasoning_summary":"auto"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"requested_reasoning_context":"current_turn"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reasoning_summary_count":1'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reasoning_summary_text_length":32'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"encrypted_reasoning_present":true'),
    );
  });

  it("fixes reasoning effort by task type", () => {
    expect(AI_GATEWAY_REASONING_EFFORT_BY_TASK).toEqual({
      generation: "high",
      analysis: "high",
      summary: "low",
    });
  });

  it("falls back once to the direct custom-codex Responses endpoint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response('{"error":{"message":"upstream unavailable"}}', {
          status: 503,
          headers: { "cf-aig-log-id": "log-primary" },
        });
      }
      return responsesOutput({ ok: true });
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
    ).resolves.toEqual({ ok: true });

    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-opencode/responses",
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
    ]);
    expect(
      calls.map((call) =>
        JSON.parse(new Headers(call.init?.headers).get("cf-aig-metadata") ?? "null"),
      ),
    ).toMatchObject([
      { ai_provider: "custom-opencode", ai_provider_attempt: "primary" },
      { ai_provider: "custom-codex", ai_provider_attempt: "fallback" },
    ]);
  });

  it("falls back when the primary output fails the business schema", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url));
      return calls.length === 1
        ? responsesOutput({ ok: "yes" })
        : responsesOutput({ ok: true });
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("bounds provider response bodies before parsing them", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response("", { headers: { "content-length": "2097153" } })
        : responsesOutput({ ok: true });
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("does not hide a non-retryable primary request error", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response('{"error":{"message":"invalid model"}}', {
        status: 400,
        headers: { "cf-aig-log-id": "log-bad-request" },
      });
    };

    await expect(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
    ).rejects.toMatchObject({
      provider: "custom-opencode",
      status: 400,
      gatewayLogId: "log-bad-request",
      retryable: false,
    } satisfies Partial<AiGatewayResponseError>);
    expect(calls).toHaveLength(1);
  });

  it("rejects local configuration errors before a provider call", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      generateAiGatewayObject(
        { ...credentials, token: "" },
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
    ).rejects.toThrow("authentication token is not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves both providers and Gateway log IDs when both attempts fail", async () => {
    const fetcher: typeof fetch = async (url) => {
      const fallback = String(url).includes("custom-codex");
      return new Response(
        JSON.stringify({ error: { message: fallback ? "fallback down" : "primary down" } }),
        {
          status: fallback ? 502 : 503,
          headers: { "cf-aig-log-id": fallback ? "log-fallback" : "log-primary" },
        },
      );
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      );
      throw new Error("expected both providers to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AiGatewayFallbackError);
      expect((error as AiGatewayFallbackError).failures).toMatchObject([
        { provider: "custom-opencode", gatewayLogId: "log-primary" },
        { provider: "custom-codex", gatewayLogId: "log-fallback" },
      ]);
    }
  });
});
