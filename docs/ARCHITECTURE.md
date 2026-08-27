# 系统架构

## 运行入口

- `fetch` 只提供 `GET /health`，其他路径返回 404。
- `scheduled` 由 Cron 触发研报增量采集。
- `ArticleWorkflow` 处理每篇文章的可重试、幂等长流程。
- `TelegramWorkflow` 每 5 分钟独立抓取央行资讯，并分步完成查重、发送与投递记账。

## 增量采集

```text
Cron → GET {ARTICLE_API_BASE_URL}/news?tag=市场解读&pageSize=100
     → runtime validation + exact tag filter
     → D1 batch lookup existing IDs
     → D1 batch insert new metadata
     → Workflow createBatch
        └─ start failed → delete this round's new dedupe rows

TelegramWorkflow schedule
 → GET {ARTICLE_API_BASE_URL}/news?tag=经济数据%26政策&pageSize=100
 → runtime validation + exact tag filter
 → title prefix filter: 中国央行
 → D1 lookup delivered IDs
 → one retryable Telegram sendMessage step per pending article
 → one retryable D1 delivery-record step per successful send
```

同一文章 ID 在正常轮询中只启动一次。Workflow 实例 ID 使用稳定的 ASCII `article-{articleId}`，不能直接使用中文标题。

研报 Cron 和 Telegram 定时 Workflow 互相独立，任一失败不会把另一条链路标记为失败。政策资讯只发送 Telegram 告警，不进入 `ArticleWorkflow`、R2 或 AI Search。Telegram 只在成功响应包含 `message_id` 后进入独立 D1 记账步骤；发送失败不落成功记录，由当前 Workflow 步骤重试，后续定时实例仍可再次发现。

`ARTICLE_API_BASE_URL` 固定指向生产 `/data` 前缀；列表和详情都必须从该统一数据入口读取。

## ArticleWorkflow

```text
DM detail
 → optional WeChat download and cleanup
 → AI feature extraction
 → D1 article + keyword
 → R2 Markdown
 → read same R2 object
 → AI Search upload and final status polling
```

- DM 详情步骤幂等更新原文 link。
- 公众号下载是独立可重试步骤；失败回退 DM 已清洗正文。
- AI 特征抽取通过统一 adapter 和 Zod Schema，先直连 AI Gateway 的 `custom-opencode/responses`，遇到网络、超时、限流、上游服务或输出校验错误时再调用 `custom-codex/responses`；两次均失败才交给 Workflow 步骤重试，残缺结果不保存。
- 特征与关键词在一次 D1 `batch()` 中覆盖。
- R2 与 AI Search 按同 key 幂等；AI Search 必须等待 `completed`，`running` 不是成功。
- `file_content_empty` 在既定重试后仍失败时成为不可重试错误，保留可诊断状态。

## 依赖规则

- `article.ts` 定义外部契约和 key；其他模块不要自行拼路径或解析未经校验的响应。
- `ingest.ts` 只负责编排去重与 Workflow 启动。
- `index.ts` 组合各 adapter，不复制存储或 HTTP 实现。
- 生产资源通过 Env bindings 注入；测试使用可替换 adapter 和 Workers runtime。
