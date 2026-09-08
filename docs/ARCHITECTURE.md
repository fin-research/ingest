# Ingest 内部架构

本文件拥有调度与模块依赖；跨服务 binding、路由和职责见 [共享架构](../../eastmoney/docs/ARCHITECTURE.md)，D1/R2 读写所有权见 [共享数据库](../../eastmoney/docs/DATABASE.md)。不要为了修改一条 Workflow 先读 Dashboard 全部文档。

## 运行入口与采集契约

- [index.ts](../src/index.ts) 的 fetch 只提供 `GET /health`，其他路径返回 404；scheduled 编排研报、央行资讯与政策三条增量链路。
- Cron 表达式与 Workflow binding 以 [wrangler.jsonc](../wrangler.jsonc) 为准；UTC `*/5 0-9 * * MON-FRI` 对应上海工作日 `[08:00, 18:00)`。
- 列表固定 `pageSize=100` 并精确复核标签；只请求 `fields=sentimentId,newsId,title,time,tags`。列表为顶层 array，详情为 object，不恢复 `list/data` envelope。
- 列表与详情统一经 [data-fetcher.ts](../src/data-fetcher.ts) 的 DATA / InternalData；`ARTICLE_API_BASE_URL` 保留生产 `/data` 前缀，不以公网匿名请求替代 binding。
- 并行采集分支必须等待完成，某分支失败不能使已经启动的另一分支悬空；所有 Promise await，步骤保持幂等。

## 按 Workflow 分流

| 链路 | 业务与步骤 | 数据规则 |
|---|---|---|
| 研报采集、ArticleWorkflow | [研报模块](modules/articles.md) | [article / keyword](DATABASE.md#article) |
| 中央政策、PolicyWorkflow | [政策模块](modules/policies.md) | [政策队列与关系](DATABASE.md#政策跟踪) |
| 央行资讯、TelegramWorkflow | [通知模块](modules/telegram.md) | [投递记录](DATABASE.md#telegram_delivery) |

## 依赖规则

- `article.ts` 定义外部契约和稳定 key，业务模块不自行解析未经校验的响应。
- `ingest.ts` 只负责编排去重和 Workflow 启动；`index.ts` 组合 adapter，不复制 HTTP 或存储实现。
- `policy.ts` 拥有政策认领恢复、归并与双向关系，`policy-archive.ts` 拥有政策归档。
- `feature-extraction.ts` 拥有特征 Prompt/Schema；`ai-gateway.ts` 是统一 AI adapter，参数只按 [共享 AI](../../eastmoney/docs/AI.md)。
- 资源由 Env bindings 注入，测试使用可替换 adapter 与 Workers runtime。Worker 不新增 Python、本地采集器或独立数据库。
