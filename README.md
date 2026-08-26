# 研报文章增量采集

`ingest` 是一个 Cloudflare Worker，定时读取 `市场解读` 研报，只处理新增文章，并把可检索内容和结构化特征送入研究数据链路。

## 处理流程

1. 工作日北京时间 08:00–18:00 每 5 分钟读取文章列表并批量去重。
2. Workflow 获取正文；微信公众号优先直连下载，失败时回退 DM 正文。
3. 通过 AI Gateway Responses API 抽取作者、摘要、重要性和权益/利率债关键词；优先 `custom-opencode`，失败时回退 `custom-codex`。
4. 把元数据和关键词写入 D1，把 Markdown 正文归档到 R2。
5. 从 R2 读取同一对象并写入 AI Search，等待最终索引结果。

D1 不保存正文。R2 和 AI Search 使用相同的 `yyyy-mm-dd/标题.md` key。

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
- [系统架构](docs/ARCHITECTURE.md)
- [D1 数据规则](docs/DATABASE.md)
- [安全边界](docs/SECURITY.md)
- [开发、维护与发布](docs/DEVELOPMENT.md)
