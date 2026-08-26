import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AiGatewayFallbackError,
  AiGatewayResponseError,
  generateAiGatewayObject,
  type AiGatewayBinding,
  type AiGatewayRunOptions,
  type AiGatewayRunRequest,
} from "../src/ai-gateway";

const options = {
  requestTimeoutMs: 120_000,
  reasoningEffort: "low" as const,
  metadata: { article_id: "A001", prompt_version: "v5" },
};

interface TestStep {
  response?: Response;
  error?: Error;
  logId?: string;
}

function responsesOutput(value: unknown, status = "completed"): Response {
  return Response.json({
    id: "resp-test",
    object: "response",
    status,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  });
}

function createAiBinding(steps: TestStep[]) {
  const calls: Array<{
    gatewayId: string;
    request: AiGatewayRunRequest;
    runOptions: AiGatewayRunOptions;
  }> = [];
  const ai: AiGatewayBinding = {
    aiGatewayLogId: null,
    gateway(gatewayId) {
      return {
        async run(request, runOptions) {
          calls.push({ gatewayId, request, runOptions });
          const step = steps.shift();
          if (!step) throw new Error("unexpected AI Gateway call");
          ai.aiGatewayLogId = step.logId ?? null;
          if (step.error) throw step.error;
          if (!step.response) throw new Error("test response is missing");
          return step.response;
        },
      };
    },
  };
  return { ai, calls };
}

describe("AI Gateway direct Responses", () => {
  it("uses the binding, primary provider and strict JSON Schema", async () => {
    const { ai, calls } = createAiBinding([
      { response: responsesOutput({ ok: true }), logId: "log-primary" },
    ]);

    const output = await generateAiGatewayObject(
      ai,
      "default",
      [
        { role: "system", content: "system" },
        { role: "user", content: "test" },
      ],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
    );

    expect(output).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gatewayId).toBe("default");
    expect(calls[0]?.request).toEqual({
      provider: "custom-opencode",
      endpoint: "responses",
      headers: {},
      query: {
        model: "gpt-5.6-luna",
        instructions: "system",
        input: [{ role: "user", content: "test" }],
        reasoning: { effort: "low" },
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
      },
    });
    expect(calls[0]?.runOptions?.gateway).toEqual({
      id: "default",
      skipCache: true,
      collectLog: true,
      requestTimeoutMs: 120_000,
      retries: { maxAttempts: 1 },
      metadata: {
        article_id: "A001",
        prompt_version: "v5",
        ai_model: "gpt-5.6-luna",
        ai_provider: "custom-opencode",
        ai_provider_attempt: "primary",
      },
    });
    expect(calls[0]?.runOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.request).not.toHaveProperty("query.max_output_tokens");
    expect(calls[0]?.request).not.toHaveProperty("query.messages");
    expect(calls[0]?.request).not.toHaveProperty("query.reasoning_effort");
  });

  it("falls back once to custom-codex after a retryable primary failure", async () => {
    const { ai, calls } = createAiBinding([
      {
        response: new Response('{"error":"upstream unavailable"}', { status: 503 }),
        logId: "log-primary-failure",
      },
      { response: responsesOutput({ ok: true }), logId: "log-fallback" },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      generateAiGatewayObject(
        ai,
        "default",
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
      ),
    ).resolves.toEqual({ ok: true });

    expect(calls.map((call) => call.request.provider)).toEqual([
      "custom-opencode",
      "custom-codex",
    ]);
    expect(
      calls.map((call) => call.runOptions?.gateway?.metadata?.ai_provider_attempt),
    ).toEqual(["primary", "fallback"]);
    vi.restoreAllMocks();
  });

  it("falls back when the primary output fails the business schema", async () => {
    const { ai, calls } = createAiBinding([
      { response: responsesOutput({ ok: "yes" }), logId: "log-invalid-schema" },
      { response: responsesOutput({ ok: true }), logId: "log-valid-schema" },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      generateAiGatewayObject(
        ai,
        "default",
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("does not mask a non-retryable primary 4xx", async () => {
    const { ai, calls } = createAiBinding([
      {
        response: new Response('{"error":"invalid model"}', { status: 400 }),
        logId: "log-bad-request",
      },
    ]);

    await expect(
      generateAiGatewayObject(
        ai,
        "default",
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
      ),
    ).rejects.toMatchObject({
      status: 400,
      gatewayLogId: "log-bad-request",
      retryable: false,
    } satisfies Partial<AiGatewayResponseError>);
    expect(calls).toHaveLength(1);
  });

  it("rejects local configuration errors before any provider call", async () => {
    const { ai, calls } = createAiBinding([]);
    await expect(
      generateAiGatewayObject(
        ai,
        "default",
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        { ...options, requestTimeoutMs: 300_001 },
      ),
    ).rejects.toThrow("request timeout must be an integer");
    expect(calls).toHaveLength(0);
  });

  it("preserves both provider attempts and log ids when fallback also fails", async () => {
    const { ai } = createAiBinding([
      {
        response: new Response('{"error":"primary down"}', { status: 503 }),
        logId: "log-primary",
      },
      {
        response: new Response('{"error":"fallback down"}', { status: 502 }),
        logId: "log-fallback",
      },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await generateAiGatewayObject(
        ai,
        "default",
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
      );
      throw new Error("expected fallback failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AiGatewayFallbackError);
      expect((error as AiGatewayFallbackError).failures).toMatchObject([
        { provider: "custom-opencode", gatewayLogId: "log-primary" },
        { provider: "custom-codex", gatewayLogId: "log-fallback" },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
