import { describe, expect, it } from "vitest";

import { runDynamicRoute } from "../src/ai-gateway";

describe("AI Gateway dynamic route", () => {
  it("uses the authenticated compat HTTP endpoint with observability headers", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    };

    const result = await runDynamicRoute(
      { accountId: "account-id", gatewayId: "default", token: "test-token" },
      { model: "dynamic/rag", messages: [{ role: "user", content: "test" }] },
      {
        requestTimeoutMs: 120_000,
        metadata: { article_id: "A001", prompt_version: "v2" },
      },
      fetcher,
    );

    expect(result).toEqual({ choices: [{ message: { content: "OK" } }] });
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/default/compat/chat/completions",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer test-token");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expect(headers.get("cf-aig-request-timeout")).toBe("120000");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "null")).toEqual({
      article_id: "A001",
      prompt_version: "v2",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ model: "dynamic/rag" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves the upstream status and gateway log id on errors", async () => {
    const fetcher: typeof fetch = async () =>
      new Response('{"error":"invalid model"}', {
        status: 400,
        headers: { "cf-aig-log-id": "log-ingest" },
      });

    await expect(
      runDynamicRoute(
        { accountId: "account-id", gatewayId: "default", token: "test-token" },
        { model: "dynamic/rag" },
        { requestTimeoutMs: 120_000, metadata: {} },
        fetcher,
      ),
    ).rejects.toMatchObject({
      status: 400,
      gatewayLogId: "log-ingest",
    });
  });
});
