import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { buildOpenMarketText, cleanOpenMarketContent, findOpenMarketBulletin, runOmo, runScheduledOmo, startOpenMarketWorkflow } from "../src/open-market";
import type { Fetcher } from "../src/article";

const date = "2026-09-17";
const start = Date.parse(`${date}T09:20:00+08:00`);
const original = "中国央行今日开展1620亿元7天逆回购操作，投标量1620亿元，中标量1620亿元，操作利率为1.40%。同时，开展了6000亿元隔夜逆回购操作。据DM数据显示，今日有30亿元7天期及6000亿元隔夜逆回购到期，当日实现净投放1590亿元。";
const cleaned = "中国央行今日开展1620亿元7天逆回购操作，操作利率为1.40%。同时，开展了6000亿元隔夜逆回购操作。";
const finalText = `${cleaned}今日有30亿元7天期及6000亿元隔夜逆回购到期，当日实现净投放1590亿元。`;
const row = { sentimentId: "omo-1", title: "中国央行今日开展逆回购", time: `${date}T09:20:00+08:00`, tags: ["经济数据&政策"], important: true };
const apiBaseUrl = "https://example.com/data";
const maturities = [
  { operationDate: date, operationName: "逆回购到期", duration: "7D", operationAmount: -30 },
  { operationDate: date, operationName: "逆回购到期", duration: "隔夜", operationAmount: -6000 },
  { operationDate: date, operationName: "国库定存", duration: "3M", operationAmount: 700 },
];

function clock(initial = start) {
  let time = initial;
  const waits: number[] = [], names: string[] = [], checkpoints = new Map();
  const step = {
    do: async (name: string, config: { retries: { limit: number; delay: string; backoff: string } }, fn: (context: { attempt: number }) => Promise<unknown>) => {
      names.push(name);
      if (checkpoints.has(name)) return checkpoints.get(name);
      expect(config.retries).toEqual({ limit: 20, delay: "15 seconds", backoff: "constant" });
      for (let attempt = 1; ; attempt++) {
        try { const value = await fn({ attempt }); checkpoints.set(name, value); return value; }
        catch (error) {
          if (error instanceof NonRetryableError || attempt > config.retries.limit) throw error;
          waits.push(15_000); time += 15_000;
        }
      }
    },
  } as unknown as Parameters<typeof runOmo>[1];
  return { now: () => time, step, waits, names, set: (value: number) => { time = value; } };
}

const successFetcher: Fetcher = async input => {
  const url = new URL(String(input));
  if (url.pathname === "/data/news") return Response.json([row]);
  if (url.pathname === "/data/omo") {
    expect(Object.fromEntries(url.searchParams)).toEqual({ startDate: date, endDate: date });
    return Response.json(maturities);
  }
  return Response.json({ content: original });
};

describe("open market bulletin", () => {
  it("removes bid amounts and the entire DM tail, preserving operation amounts and rates", () => {
    expect(cleanOpenMarketContent(original)).toBe(cleaned);
    expect(cleanOpenMarketContent(cleaned)).toBe(cleaned);
    for (const marker of ["DM数据显示", "据DM数据显示", "【据DM数据显示"]) {
      expect(cleanOpenMarketContent(`中国央行开展1620亿元7天逆回购操作，投标量为1,620亿元，中标量：1620亿元。${marker}：旧净回笼30亿元。尾注`))
        .toBe("中国央行开展1620亿元7天逆回购操作。");
    }
  });

  it("accepts injection-only news after checking date, title, tag and importance", async () => {
    const paths: string[] = [];
    const fetcher: Fetcher = async input => {
      const url = new URL(String(input)); paths.push(url.pathname);
      if (url.pathname === "/data/news") {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ date, tag: "经济数据&政策", important: "true", pageSize: "100" });
        expect(url.searchParams.get("fields")).toContain("important");
        return Response.json([
          { ...row, sentimentId: "yesterday", time: "2026-09-16T09:20:00+08:00" },
          { ...row, sentimentId: "other", title: "其他央行" },
          { ...row, sentimentId: "wrong-tag", tags: ["政策"] },
          { ...row, sentimentId: "unimportant", important: false },
          { ...row, sentimentId: "broken-detail" },
          { ...row, sentimentId: "unrelated" }, row,
        ]);
      }
      if (url.pathname.endsWith("broken-detail")) return new Response(null, { status: 503 });
      return Response.json({ content: url.pathname.endsWith("unrelated") ? "中国央行下调存款准备金率。" : cleaned });
    };
    await expect(findOpenMarketBulletin(date, { apiBaseUrl, fetcher }, new AbortController().signal))
      .resolves.toEqual({ articleId: "omo-1", text: cleaned });
    expect(paths).toEqual(["/data/news", "/data/news/broken-detail", "/data/news/unrelated", "/data/news/omo-1"]);
  });

  it("uses two semantic steps; missing news and transient errors use native retry configuration", async () => {
    const time = clock(); let requests = 0;
    const fetcher: Fetcher = async input => {
      if (String(input).includes("/news?")) {
        requests++;
        if (requests === 1) throw new Error("upstream secret must never be sent");
        if (requests === 2) return Response.json([]);
      }
      return successFetcher(input);
    };
    expect(await runOmo(date, time.step, { apiBaseUrl, fetcher }))
      .toMatchObject({ status: "found", attempts: 3, errors: 2, text: finalText });
    expect(time.waits).toEqual([15_000, 15_000]);
    expect(time.names).toEqual(["获取并清洗央行投放公告", "查询到期回笼并生成播报"]);
  });

  it.each(["empty", "http-error", "invalid-json"])("exhausts 20 native retries without polling steps for %s", async mode => {
    const time = clock();
    const fetcher = vi.fn(async () => mode === "empty" ? Response.json([])
      : mode === "http-error" ? new Response("private details", { status: 503 }) : new Response("invalid"));
    await expect(runOmo(date, time.step, { apiBaseUrl, fetcher })).rejects.toThrow(mode === "empty" ? "尚未获取" : mode === "http-error" ? "OMO upstream HTTP 503" : "OMO query failed");
    expect(time.now()).toBe(start + 300_000);
    expect(time.waits).toHaveLength(20);
    expect(fetcher).toHaveBeenCalledTimes(21);
    expect(time.names).toEqual(["获取并清洗央行投放公告"]);
  });

  it("starts and completes after 09:25 using the requested date without a time cutoff", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start + 3600_000);
    try {
      const time = clock(start + 3600_000);
      expect((await runOmo(date, time.step, { apiBaseUrl, fetcher: successFetcher })).text).toBe(finalText);
      expect(time.names).toHaveLength(2);
      expect(time.waits).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("computes the supplied result from maturities and handles signed or unsigned expiry amounts", () => {
    expect(buildOpenMarketText(date, cleaned, maturities)).toBe(finalText);
    expect(buildOpenMarketText(date, cleaned, maturities.map(row => ({ ...row, operationAmount: Math.abs(row.operationAmount) })))).toBe(finalText);
    expect(buildOpenMarketText(date, "中国央行今日开展0.762万亿元7天逆回购操作。", maturities)).toContain("净投放1590亿元");
  });

  it("reproduces the real September 18 result and ignores unrelated API injections", () => {
    const text = "中国央行今日开展4633亿元7天逆回购操作，操作利率为1.40%。同时，以固定数量、利率招标、多重价位中标方式开展了1000亿元14天期逆回购操作。";
    const payload = maturities.map((row, i) => ({ ...row, operationDate: "2026-09-18", operationAmount: i === 0 ? -40 : row.operationAmount }));
    expect(buildOpenMarketText("2026-09-18", text, payload)).toBe(`${text}今日有40亿元7天期及6000亿元隔夜逆回购到期，当日实现净回笼407亿元。`);
    expect(buildOpenMarketText(date, "中国央行今日开展6030亿元7天逆回购操作。", maturities)).toContain("当日投放与回笼量持平");
  });

  it("rejects absent, incomplete or wrong-day maturity data instead of substituting zero", () => {
    for (const payload of [[], [maturities[2]], { rows: maturities }, [{ ...maturities[0], operationDate: "2026-09-16" }],
      [{ ...maturities[0], operationAmount: null }], [{ ...maturities[0], duration: null }]]) {
      expect(() => buildOpenMarketText(date, cleaned, payload)).toThrow();
    }
  });

  it("retries only the maturity step after upstream failure and reuses both completed checkpoints", async () => {
    const time = clock(); let news = 0, operations = 0;
    const fetcher: Fetcher = async input => {
      if (String(input).includes("/news?")) news++;
      if (String(input).includes("/omo?")) {
        operations++;
        if (operations === 1) return Response.json([]);
      }
      return successFetcher(input);
    };
    const result = await runOmo(date, time.step, { apiBaseUrl, fetcher });
    expect(result.text).toBe(finalText);
    expect(news).toBe(1); expect(operations).toBe(2);
    time.set(start + 3600_000);
    expect(await runOmo(date, time.step, { apiBaseUrl, fetcher })).toEqual(result);
    expect(news).toBe(1); expect(operations).toBe(2);
  });

  it("prepares at weekday 09:10 with 09:15 and 09:20 fallbacks with the same daily instance ID on repeated Cron delivery", async () => {
    const createBatch = vi.fn(async () => []);
    const binding = { OMO_WORKFLOW: { createBatch } } as unknown as Pick<Env, "OMO_WORKFLOW">;
    for (const value of [start, start, start - 600_000, start - 300_000, start - 900_000, start + 300_000, Date.parse("2026-09-19T09:20:00+08:00")]) {
      await startOpenMarketWorkflow(binding, value);
    }
    expect(createBatch).toHaveBeenCalledTimes(4);
    expect(createBatch).toHaveBeenLastCalledWith([{ id: "omo-2026-09-17", params: { date, scheduledStart: `${date}T09:20:00+08:00` } }]);
  });

  it("waits for business time before requesting data and leaves manual runs immediate", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const sleepUntil = vi.fn(async (_name: string, target: Date) => {
      expect(target.valueOf()).toBe(start);
      await waiting;
    });
    const fetcher = vi.fn(successFetcher);
    const pending = runScheduledOmo({ date, scheduledStart: `${date}T09:20:00+08:00` },
      { ...clock().step, sleepUntil } as Parameters<typeof runScheduledOmo>[1], { apiBaseUrl, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    release();
    expect((await pending).text).toBe(finalText);
    expect(sleepUntil).toHaveBeenCalledOnce();
    sleepUntil.mockClear();
    expect((await runScheduledOmo({ date }, { ...clock().step, sleepUntil } as Parameters<typeof runScheduledOmo>[1],
      { apiBaseUrl, fetcher })).text).toBe(finalText);
    expect(sleepUntil).not.toHaveBeenCalled();
    await expect(runScheduledOmo({ date, scheduledStart: "2026-09-18T09:20:00+08:00" },
      { ...clock().step, sleepUntil } as Parameters<typeof runScheduledOmo>[1], { apiBaseUrl, fetcher }))
      .rejects.toThrow("Invalid omo scheduled start");
  });

  it("accepts an existing daily instance after a duplicate or ambiguous create, but surfaces missing instances", async () => {
    const status = vi.fn(async () => ({ status: "running" }));
    const get = vi.fn(async () => ({ status }));
    const binding = { OMO_WORKFLOW: {
      createBatch: vi.fn(async () => { throw new Error("duplicate or connection interrupted"); }), get,
    } } as unknown as Pick<Env, "OMO_WORKFLOW">;
    await expect(startOpenMarketWorkflow(binding, start)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(`omo-${date}`);
    expect(status).toHaveBeenCalledOnce();
    status.mockRejectedValueOnce(new Error("instance missing"));
    await expect(startOpenMarketWorkflow(binding, start)).rejects.toThrow("instance missing");
  });

  it("bounds each stalled request independently without a publication deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start + 299_000);
    try {
      const step = { do: async (_name: string, _config: unknown, fn: (context: { attempt: number }) => Promise<unknown>) => fn({ attempt: 1 }) } as unknown as Parameters<typeof runOmo>[1];
      const fetcher = vi.fn(async (): Promise<Response> => new Promise(() => {}));
      const pending = expect(runOmo(date, step, { apiBaseUrl, fetcher })).rejects.toThrow("OMO query timed out");
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(["invalid-date", "2026-02-31"])("invalid dates fail without retries or requests: %s", async pollDate => {
    const time = clock(); const fetcher = vi.fn();
    await expect(runOmo(pollDate, time.step, { apiBaseUrl, fetcher }))
      .rejects.toThrow("Invalid omo date");
    expect(time.waits).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["invalid-date", "2026-02-31"])("platform marks invalid omo as errored: %s", async pollDate => {
    const id = `omo-${pollDate}-test`;
    const instance = await introspectWorkflowInstance(env.OMO_WORKFLOW, id);
    await env.OMO_WORKFLOW.create({ id, params: { date: pollDate } });
    await expect(instance.waitForStatus("errored")).resolves.toBeUndefined();
    const status = await (await env.OMO_WORKFLOW.get(id)).status();
    // workerd wraps NonRetryableError in a platform termination message.
    // Exact business errors are checked below without that runtime wrapper.
    expect(status.status).toBe("errored");
    expect(status.error).toBeTruthy();
    await instance.dispose();
  });
});
