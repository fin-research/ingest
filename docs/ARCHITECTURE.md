# 系统架构

## 运行入口

- `fetch` 只提供 `GET /health`，其他路径返回 404。
- `scheduled` 由 Cron 触发研报增量采集，同时抓取并去重匹配的政策资讯。
- `ArticleWorkflow` 处理每篇文章的可重试、幂等长流程。
- `TelegramWorkflow` 只在发现标题以 `中国央行：` 开头的新增政策资讯时创建，一个实例处理本轮全部新增资讯。
- `PolicyWorkflow` 处理一批待聚合 `中央政策` 资讯，完成正文补齐、AI 归并、D1 入库与既有研报关联。

## 增量采集

```text
Cron → GET {ARTICLE_API_BASE_URL}/news?tag=市场解读&pageSize=100&fields=sentimentId,newsId,title,time,tags
     → runtime validation + exact tag filter
     → D1 batch lookup existing IDs
     → D1 batch insert new metadata
     → Workflow createBatch
        └─ start failed → delete this round's new dedupe rows

Cron → GET {ARTICLE_API_BASE_URL}/news?tag=经济数据%26政策&pageSize=100&fields=sentimentId,newsId,title,time,tags
     → runtime validation + exact tag filter
     → title prefix filter: 中国央行：（全角冒号必需）
     → D1 lookup existing IDs
     → no new article: stop without creating a Workflow
     → new articles: create one TelegramWorkflow telegram-{scheduledTime}
        1. store Telegram notifications in D1 as pending
        2. send pending notifications and record message IDs

Cron → GET {ARTICLE_API_BASE_URL}/news?tag=中央政策&pageSize=100&fields=sentimentId,newsId,title,time,tags
     → runtime validation + exact tag filter
     → D1 insert pending policy_news + claim unowned or stale rows
     → create one PolicyWorkflow policy-{scheduledTime}
        1. bounded-concurrency DM detail fetch
        2. AI 按政策事件/政策包口径归并，并复核近期 policy_event 是否为同一政策包碎片
        3. D1 批量更新规范 policy_event、迁移碎片卡片证据并写入 policy_news
        4. AI match existing article rows from policy date -1 to +14 days
```

同一文章 ID 在正常轮询中只进入一个 Telegram Workflow。文章 Workflow 实例 ID 使用稳定的 ASCII `article-{articleId}`；Telegram Workflow 使用本轮 Cron 时间戳 `telegram-{scheduledTime}`，不能直接使用中文标题。

Cron 会并行等待研报采集与 Telegram 抓取去重，因此任一分支失败时仍会完成另一分支。新增匹配资讯由 Workflow 第一步批量写入 D1，第二步才读取 Secret 并调用 Telegram；发送成功后在同一步更新 `sent_at` 与 `telegram_message_id`。第二步重试时先跳过已有 message ID 的记录，避免重复发送已确认成功的资讯。政策资讯不进入 `ArticleWorkflow`、R2 或 AI Search。

`ARTICLE_API_BASE_URL` 固定指向生产 `/data` 前缀；列表和详情都必须从该统一数据入口读取。

## ArticleWorkflow

```text
DM detail
 → optional WeChat download and cleanup
 → AI feature extraction
 → D1 article + keyword
 → AI match against policies from the previous 14 days
 → R2 Markdown
 → read same R2 object
 → AI Search upload and final status polling
```

- DM 详情步骤幂等更新原文 link。
- 公众号下载是独立可重试步骤；失败回退 DM 已清洗正文。
- AI 特征抽取通过统一 adapter 和 Zod Schema，先直连 AI Gateway 的 `custom-opencode/responses`，遇到网络、超时、限流、上游服务或输出校验错误时再调用 `custom-codex/responses`；两次均失败才交给 Workflow 步骤重试，残缺结果不保存。
- 特征与关键词在一次 D1 `batch()` 中覆盖。
- 自动研报关系只使用 article 的标题、摘要、机构和结构化关键词。研报触发时，一篇研报与其全部候选政策在一次模型调用中判断，Schema 以政策 ID 为键且每项只包含 `related` 布尔值；政策触发时，每个政策与其全部候选研报同样在一次调用中判断，Schema 改以研报 ID 为键。仅保存判断为直接相关的关系，人工 `linked` / `excluded` 决定不被后续 AI upsert 覆盖。
- 政策聚合以共同改革目标和集中发布安排为上位口径：同一政策包可包含不同部门、不同文件和不同政策工具；只有宽泛行业主题相同不能合并。近期碎片卡片可自动归并到总览卡片，但含人工研报关系或研究点评的卡片不得作为被合并来源。
- R2 与 AI Search 按同 key 幂等；AI Search 必须等待 `completed`，`running` 不是成功。
- `file_content_empty` 在既定重试后仍失败时成为不可重试错误，保留可诊断状态。

## 依赖规则

- `article.ts` 定义外部契约和 key；其他模块不要自行拼路径或解析未经校验的响应。
- `ingest.ts` 只负责编排去重与 Workflow 启动。
- `index.ts` 组合各 adapter，不复制存储或 HTTP 实现。
- `policy.ts` 维护待处理政策资讯的认领恢复、聚合 Schema、双向研报关联和 D1 写入；页面不参与政策归并。
- 生产资源通过 Env bindings 注入；测试使用可替换 adapter 和 Workers runtime。
