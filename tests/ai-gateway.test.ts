import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AiGatewayResponseError,
  generateDynamicRouteObject,
  generateDynamicRouteText,
} from "../src/ai-gateway";

const credentials = {
  accountId: "account-id",
  gatewayId: "default",
  token: "test-token",
};

const options = {
  requestTimeoutMs: 120_000,
  maxRetries: 0,
  reasoningEffort: "low" as const,
  enableThinking: false,
  metadata: { article_id: "A001", prompt_version: "v4" },
};

function chatCompletion(content: string): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.6-luna",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: null },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

describe("AI Gateway dynamic route", () => {
  it("uses the AI SDK and authenticated compat endpoint with the verified allowlist", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return chatCompletion("OK");
    };

    const result = await generateDynamicRouteText(
      credentials,
      [{ role: "user", content: "test" }],
      options,
      fetcher,
    );

    expect(result).toBe("OK");
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/default/compat/chat/completions",
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer test-token");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expect(headers.get("cf-aig-request-timeout")).toBe("120000");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "null")).toEqual(
      options.metadata,
    );
    const query = JSON.parse(String(calls[0]?.init?.body));
    expect(query).toMatchObject({
      model: "dynamic/rag",
      temperature: 0.1,
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: "test" }],
    });
    for (const rejected of [
      "top_p",
      "top_k",
      "repetition_penalty",
      "seed",
      "max_completion_tokens",
    ]) {
      expect(query).not.toHaveProperty(rejected);
    }
  });

  it("sends one standard JSON Schema and returns an SDK-validated object", async () => {
    let query: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      query = JSON.parse(String(init?.body));
      return chatCompletion('{"ok":true}');
    };

    const output = await generateDynamicRouteObject(
      credentials,
      [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    );

    expect(output).toEqual({ ok: true });
    expect(query.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "probe",
        strict: true,
        schema: {
          type: "object",
          required: ["ok"],
          additionalProperties: false,
        },
      },
    });
    expect(query.messages).toEqual([{ role: "user", content: "test" }]);
  });

  it("rejects JSON that does not satisfy the response schema", async () => {
    const fetcher: typeof fetch = async () => chatCompletion('{"ok":"yes"}');

    await expect(
      generateDynamicRouteObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
    ).rejects.toMatchObject({ name: "AI_NoObjectGeneratedError" });
  });

  it("preserves the upstream status and gateway log id on errors", async () => {
    const fetcher: typeof fetch = async () =>
      new Response('{"error":"invalid model"}', {
        status: 400,
        headers: { "cf-aig-log-id": "log-ingest" },
      });

    await expect(
      generateDynamicRouteText(
        credentials,
        [{ role: "user", content: "test" }],
        options,
        fetcher,
      ),
    ).rejects.toMatchObject({
      status: 400,
      gatewayLogId: "log-ingest",
    } satisfies Partial<AiGatewayResponseError>);
  });
});
