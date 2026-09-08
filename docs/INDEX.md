# Ingest 模块分流

先完整读取 [AGENTS](../AGENTS.md)，按任务选择下面一行与所需技术专题。不要默认通读所有文档，不重复读取已有上下文；跨项目问题由 [项目组索引](../../eastmoney/docs/INDEX.md) 分流。

| 任务/模块 | 最小文档 | 代码证据 |
|---|---|---|
| Cron、DATA 契约、Workflow 启动 | [ARCHITECTURE](ARCHITECTURE.md) | [index](../src/index.ts)、[ingest](../src/ingest.ts)、[data-fetcher](../src/data-fetcher.ts) |
| 研报正文、公众号、特征与归档 | [研报模块](modules/articles.md) | 模块内链接 article / wechat / feature-extraction |
| 政策队列、归并、重要性、双向研报关系 | [政策模块](modules/policies.md) | policy / policy-archive |
| 央行资讯与 Telegram | [通知模块](modules/telegram.md) | TelegramWorkflow |
| D1 幂等、字段、migration | [DATABASE](DATABASE.md) + 目标模块 | 共享结构变化才加读 [共享 D1](../../eastmoney/docs/DATABASE.md#共享-d1) |
| R2 路径、元数据、AI Search 索引 | 目标归档模块 + [共享归档协议](../../eastmoney/docs/DATABASE.md#研究归档协议) | 不读取 Dashboard 其他存储模块 |
| Prompt / Schema / Gateway | 目标模块 + [共享 AI](../../eastmoney/docs/AI.md) | [ai-gateway](../src/ai-gateway.ts) |
| Secret、日志、维护权限 | [SECURITY](SECURITY.md) | Worker Secret / Secrets Store bindings |
| 本地验证、维护、Git 自动部署 | [DEVELOPMENT](DEVELOPMENT.md) | [package](../package.json)、[wrangler](../wrangler.jsonc) |

Dashboard 只在修改共享政策/研报契约时作为受影响消费者读取；本仓库无 UI，不创建 DESIGN 或页面文档。

权限架构、权限范围与匿名/测试账号程序化验收 → [共享 AUTH](../../eastmoney/docs/AUTH.md)。禁止 browser；本仓库覆盖范围与命令见 AUTH 的测试表。
