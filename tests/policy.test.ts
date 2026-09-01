import { describe, expect, it } from "vitest";

import type { ArticleMetadata } from "../src/article";
import {
  policyWorkflowInstanceId,
  runPolicyCollection,
  type ExistingPolicy,
  type PolicyAggregationResult,
  type PolicyNewsEvidence,
  type PolicyNewsRepository,
  type PolicyNewsRow,
  type PolicyWorkflowLauncher,
  type PolicyWorkflowSummary,
} from "../src/policy";

const apiRows = [
  {
    sentimentId: "policy-1",
    newsId: "news-1",
    title: "中国央行、金融监管总局印发房地产信贷管理意见",
    time: "2026-09-01T19:00:00+08:00",
    tags: ["中央政策", "房地产"],
  },
  {
    sentimentId: "policy-2",
    newsId: "news-2",
    title: "个人住房贷款期限最长延长至40年",
    time: "2026-09-01T19:10:00+08:00",
    tags: ["中央政策", "房地产"],
  },
];

class MemoryPolicyRepository implements PolicyNewsRepository {
  claimed = false;
  released = false;

  async queueAndClaim(
    articles: ArticleMetadata[],
    workflowInstanceId: string,
    discoveredAt: string,
  ): Promise<PolicyNewsRow[]> {
    if (this.claimed) return [];
    this.claimed = true;
    return articles.map((article) => ({
      ...article,
      discoveredAt,
      workflowInstanceId,
    }));
  }

  async releaseClaim(): Promise<void> {
    this.released = true;
    this.claimed = false;
  }

  async loadClaimed(): Promise<PolicyNewsRow[]> {
    return [];
  }

  async loadRecentPolicies(): Promise<ExistingPolicy[]> {
    return [];
  }

  async saveAggregation(
    _workflowInstanceId: string,
    _evidence: PolicyNewsEvidence[],
    _aggregation: PolicyAggregationResult,
    _savedAt: string,
  ): Promise<PolicyWorkflowSummary> {
    throw new Error("not used by collector test");
  }
}

class MemoryPolicyWorkflow implements PolicyWorkflowLauncher {
  ids: string[] = [];

  async start(workflowInstanceId: string): Promise<string> {
    this.ids.push(workflowInstanceId);
    return workflowInstanceId;
  }
}

describe("central policy collection", () => {
  it("claims exact central-policy news and starts one aggregation workflow", async () => {
    const repository = new MemoryPolicyRepository();
    const workflow = new MemoryPolicyWorkflow();
    const dependencies = {
      apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
      repository,
      workflow,
      fetcher: async (): Promise<Response> => Response.json(apiRows),
    };

    const first = await runPolicyCollection(dependencies, "2026-09-01T11:15:00Z");
    const second = await runPolicyCollection(dependencies, "2026-09-01T11:20:00Z");

    expect(first).toEqual({ fetched: 2, claimed: 2, workflows: 1 });
    expect(second).toEqual({ fetched: 2, claimed: 0, workflows: 0 });
    expect(workflow.ids).toEqual(["policy-1788261300000"]);
  });

  it("releases claimed news when Workflow dispatch fails", async () => {
    const repository = new MemoryPolicyRepository();

    await expect(runPolicyCollection(
      {
        apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
        repository,
        workflow: {
          async start(): Promise<string> {
            throw new Error("workflow unavailable");
          },
        },
        fetcher: async (): Promise<Response> => Response.json(apiRows),
      },
      "2026-09-01T11:15:00Z",
    )).rejects.toThrow("workflow unavailable");

    expect(repository.released).toBe(true);
  });

  it("uses a stable Workflow identity derived from the Cron timestamp", () => {
    expect(policyWorkflowInstanceId("2026-09-01T11:15:00Z")).toBe(
      "policy-1788261300000",
    );
  });
});
