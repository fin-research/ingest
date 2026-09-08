# 政策采集、归并与研报关联

源列表精确匹配 `中央政策`，每次 `pageSize=100`。页面展示、人工关系和研究点评属于 Dashboard [政策跟踪](../../../dashboard/docs/modules/policy-tracking.md)；共享表所有权只读 [项目组数据库](../../../eastmoney/docs/DATABASE.md#共享-d1)。

## PolicyWorkflow

```text
Cron → pending policy_news → 认领未占用/已超时记录
     → policy-{scheduledTime} Workflow
     → 有界并发补齐 DM 正文
     → AI 按政策事件/政策包归并并判定境内资金/利率重要性
     → D1 更新规范 policy_event、迁移碎片证据、更新 policy_news
     → R2 policy/ 归档
     → 匹配政策日期 -1 至 +14 日的已有研报
```

- 待处理资讯认领和超时恢复由 `policy.ts` 管理，不把归并移到页面加载。
- 政策正文保留在 D1；事件重要性为 `important` / `related` / `general`，不按泛行业热点替代境内资金与利率影响。
- 自动研报关系只使用 article 的标题、摘要、机构和结构化关键词。研报触发时，一篇研报与其全部候选政策在一次模型调用中判断，Schema 以政策 ID 为键且每项只包含 `related` 布尔值；政策触发时，每个政策与其全部候选研报同样在一次调用中判断，Schema 改以研报 ID 为键。仅保存判断为直接相关的关系，人工 `linked` / `excluded` 决定不被后续 AI upsert 覆盖。
- 政策聚合以共同改革目标和集中发布安排为上位口径：同一政策包可包含不同部门、不同文件和不同政策工具；只有宽泛行业主题相同不能合并。近期碎片卡片可自动归并到总览卡片，但含人工研报关系或研究点评的卡片不得作为被合并来源。
- 研报特征入库时另触发过去 14 天政策候选匹配；政策入库与研报入库两方向都须保留。
- D1 表粒度、状态、保护条件和事务细节见 [DATABASE 政策跟踪](../DATABASE.md#政策跟踪)。
- R2 key、中文标点处理、`type`、`published_at` 与索引边界只按 [研究归档协议](../../../eastmoney/docs/DATABASE.md#研究归档协议) 维护。

## 实现与验证

[policy.ts](../../src/policy.ts) 拥有认领、Schema、Prompt、归并和双向匹配；[policy-archive.ts](../../src/policy-archive.ts) 拥有政策 Markdown 与 R2 adapter；[index.ts](../../src/index.ts) 只编排步骤。AI 参数按 [共享 AI](../../../eastmoney/docs/AI.md)。

结构变化同时核对两仓库 migration、本地镜像和 Dashboard 读取方；默认测试见 [DEVELOPMENT](../DEVELOPMENT.md)，专项从 [tests](../../tests) 的 policy 测试进入。
