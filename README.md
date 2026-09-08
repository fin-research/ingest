# 研报文章增量采集

`ingest` 是一个 Cloudflare Worker，定时读取 `市场解读` 研报，只处理新增文章，并把可检索内容和结构化特征送入研究数据链路。

## 处理流程

1. 工作日北京时间 08:00–18:00 每 5 分钟读取文章列表并批量去重。
2. Workflow 获取正文；微信公众号优先直连下载，失败时回退 DM 正文。
3. 通过 AI Gateway Responses API 抽取作者、摘要、重要性和权益/利率债关键词；统一使用 `custom-codex`，可重试失败时仅重试同一 Provider 一次。
4. 把元数据和关键词写入 D1，把 Markdown 正文归档到 R2。
5. AI Search 通过 R2 数据源自动同步文章；Workflow 在 R2 归档完成后结束，索引状态独立检查。

正文归档、检索元数据和索引完成边界见 [共享存储](../eastmoney/docs/DATABASE.md#研究归档协议)；按 [模块索引](docs/INDEX.md) 分别查看研报、政策与央行通知。

## 本地验证

```bash
pnpm install
pnpm types
pnpm db:migrate:local
pnpm check
pnpm test
pnpm deploy:dry
```

日常发布由 Cloudflare Git 自动完成：验证后提交并推送 `main`，不手动部署 Worker。

## 文档

- [AI Agent 入口](AGENTS.md)
- [模块分流](docs/INDEX.md)
- [项目组共享文档](../eastmoney/docs/INDEX.md)
- [系统架构](docs/ARCHITECTURE.md)
- [D1 数据规则](docs/DATABASE.md)
- [安全边界](docs/SECURITY.md)
- [开发、维护与发布](docs/DEVELOPMENT.md)
