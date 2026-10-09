# Ingest 内部架构

本文件拥有调度与模块依赖；跨服务 binding、路由和职责见 [共享架构](../../eastmoney/docs/ARCHITECTURE.md)，D1/R2 读写所有权见 [共享数据库](../../eastmoney/docs/DATABASE.md)。不要为了修改一条 Workflow 先读 Dashboard 全部文档。

## 运行入口与采集契约

- [index.ts](../src/index.ts) 的 fetch 只提供 `GET /health`，其他路径返回 404；scheduled 编排研报、央行资讯与政策三条增量链路，并在工作日北京时间 09:20 启动当日公开市场播报 Workflow。
- Cron 表达式与 Workflow binding 以 [wrangler.jsonc](../wrangler.jsonc) 为准；UTC `*/5 0-9 * * MON-FRI` 对应上海工作日 `[08:00, 18:00)`。
- 四路采集/Workflow 创建前，按 `scheduledTime` 的上海日期检查周末及 DATA `/data/trading-days` 的 Choice 上交所日历。有效休市响应正常跳过；日历异常记录 `ingest_calendar_unavailable` 并停止本轮，下次五分钟 Cron 重试，不默认放行。成功日历由 Data 在当前边缘节点缓存，错误不缓存。
- 列表固定 `pageSize=100` 并精确复核标签；只请求 `fields=sentimentId,newsId,title,time,tags`。公开市场播报使用 `date` 过滤，不要求 `important=true`。列表为顶层 array，详情为 object，不恢复 `list/data` envelope。
- 列表与详情统一经 [data-fetcher.ts](../src/data-fetcher.ts) 的 DATA / InternalData；`ARTICLE_API_BASE_URL` 保留生产 `/data` 前缀，不以公网匿名请求替代 binding。研报同时读取仅关注公众号列表，与news按标题和上海日期去重；订阅正文采用预抓DM文本快照，见[研报模块](modules/articles.md)。
- 并行采集分支必须等待完成，某分支失败不能使已经启动的另一分支悬空；所有 Promise await，步骤保持幂等。

## 按 Workflow 分流

| 链路 | 业务与步骤 | 数据规则 |
|---|---|---|
| 研报采集、ArticleWorkflow | [研报模块](modules/articles.md) | [article / keyword](DATABASE.md#article) |
| 中央政策、PolicyWorkflow | [政策模块](modules/policies.md) | [政策队列与关系](DATABASE.md#政策跟踪) |
| 央行资讯、TelegramWorkflow | [通知模块](modules/telegram.md) | [投递记录](DATABASE.md#telegram_delivery) |

公开市场播报使用 `OmoWorkflow` / `omo`，日实例 ID 为 `omo-YYYY-MM-DD`。复用现有 Cron，不额外增加重复调度。步骤和失败通知见[公开市场播报](modules/open-market.md)。

## 依赖规则

- `article.ts` 定义外部契约和稳定 key，业务模块不自行解析未经校验的响应。
- `ingest.ts` 只负责编排去重和 Workflow 启动；`index.ts` 组合 adapter，不复制 HTTP 或存储实现。
- `policy.ts` 拥有政策认领恢复、归并与双向关系，`policy-archive.ts` 拥有政策归档。
- `feature-extraction.ts` 拥有特征 Prompt/Schema；`ai-gateway.ts` 是统一 AI adapter，参数只按 [共享 AI](../../eastmoney/docs/AI.md)。
- 资源由 Env bindings 注入，测试使用可替换 adapter 与 Workers runtime。Worker 不新增 Python、本地采集器或独立数据库。
