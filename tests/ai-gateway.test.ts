import { describe, expect, it } from "vitest";

import { runDynamicRoute } from "../src/ai-gateway";

describe("AI Gateway dynamic route", () => {
  it("uses the compat gateway binding with observability headers", async () => {
    const calls: Array<{ gatewayId: string; request: AIGatewayUniversalRequest }> = [];
    const ai = {
      gateway: (gatewayId: string) => ({
        run: async (request: AIGatewayUniversalRequest) => {
          calls.push({ gatewayId, request });
          return Response.json({ choices: [{ message: { content: "OK" } }] });
        },
      }),
    } as unknown as Ai;

    const result = await runDynamicRoute(
      ai,
      "default",
      { model: "dynamic/rag", messages: [{ role: "user", content: "test" }] },
      {
        requestTimeoutMs: 120_000,
        metadata: { article_id: "A001", prompt_version: "v2" },
      },
    );

    expect(result).toEqual({ choices: [{ message: { content: "OK" } }] });
    expect(calls[0]?.gatewayId).toBe("default");
    expect(calls[0]?.request.provider).toBe("compat");
    expect(calls[0]?.request.endpoint).toBe("chat/completions");
    expect(calls[0]?.request.query).toMatchObject({ model: "dynamic/rag" });
    expect(calls[0]?.request.headers).toMatchObject({
      "cf-aig-skip-cache": true,
      "cf-aig-collect-log": true,
      "cf-aig-request-timeout": 120_000,
      "cf-aig-metadata": { article_id: "A001", prompt_version: "v2" },
    });
  });

  it("preserves the upstream status and gateway log id on errors", async () => {
    const ai = {
      gateway: () => ({
        run: async () =>
          new Response('{"error":"invalid model"}', {
            status: 400,
            headers: { "cf-aig-log-id": "log-ingest" },
          }),
      }),
    } as unknown as Ai;

    await expect(
      runDynamicRoute(ai, "default", { model: "dynamic/rag" }, {
        requestTimeoutMs: 120_000,
        metadata: {},
      }),
    ).rejects.toMatchObject({
      status: 400,
      gatewayLogId: "log-ingest",
    });
  });
});
