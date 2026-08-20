# 研报文章增量采集

`ingest` 是纯 TypeScript Cloudflare Worker。Cron 在工作日北京时间 08:00–18:00 时段内每 5 分钟调用公网数据 API，读取 `tag=市场解读` 的研报列表，以 D1 主键批量去重，只把新增文章交给固定的 `article` Workflow。

Workflow 每篇文章执行六个基础步骤；微信公众号文章会多执行一个可重试步骤：

1. 通过 `/api/news/{sentimentId}` 获取文章全文和原文链接；缺少 `sentimentId` 时回退到 `newsId`，并在同一步把原文链接幂等写入 D1。
2. 若链接指向微信公众号，单独执行公众号直连下载、HTML 转 Markdown 与风险披露清洗，并删除图片及链接 URL（保留链接锚文本）；失败时回退到 DM 正文。
3. 通过 AI Gateway `compat/chat/completions` 调用 `dynamic/rag` 路由，抽取标题、作者/机构、摘要、统一重要性分值，以及面向权益和利率债的结构化关键词。
4. 把文章特征写回 D1 `article`，把关键词逐条写入 D1 `keyword`。
5. 写入 R2 `article` 存储桶，键为 `yyyy-mm-dd/标题.md`。
6. 从 R2 读取同一对象并上传到 AI Search `default/finance`。

文章特征通过 AI SDK 的 OpenAI-compatible provider，经 AI Gateway `default` 的 `compat/chat/completions` 端点调用 `dynamic/rag`。Zod Schema 是输出结构的唯一来源：SDK 自动发送标准 `response_format.json_schema`、由适配器生成同源兼容指令，并在应用端校验对象。抽取关闭 thinking；Gateway 缓存关闭，保留日志和用量观测。`CLOUDFLARE_ACCOUNT_ID` 和 `AI_GATEWAY_ID` 是非敏感变量，Cloudflare token 仅通过生产 Worker Secret `CF_AIG_TOKEN` 注入，不写入源码或 Wrangler 配置。该 `compat` 端点已被 Cloudflare 标记为 deprecated，但目前仍是 Dynamic Routing 官方要求且已经验证的调用路径；迁移新版 REST API 前须重新验证动态路由兼容性。完整规范见项目根目录 `README.md`。

## 数据与写入策略

- 数据源环境变量：`ARTICLE_API_BASE_URL=https://eastmoney.hasbai.xyz/api`。
- 列表请求：`GET /news?tag=市场解读&pageSize=100`。
- Worker 名为 `ingest`，D1 数据库名为 `eastmoney`；D1 保存文章 ID、标题、发布时间、发现时间、原文 `link`、作者、摘要、重要性、模型和 Prompt 版本等元数据，不保存正文。
- `keyword` 以 `(article_id, ordinal)` 为主键，保存 `topic/fact/interpretation/impact`；同一文章重跑抽取时以一个 D1 `batch()` 原子覆盖。当前生产 Prompt 版本为 `v4-ai-sdk-json-schema`。
- 输入正文不截断，不设置 completion token 上限；响应限长读取，任何不完整或不符合 Schema 的输出都由 AI SDK 拒绝，Workflow 重试且不会保存残缺数据。
- 每轮使用一次 `IN (...)` 批量查重；只有新增文章才通过一次 D1 `batch()` 写入，重复轮询不产生写操作。
- Workflow 使用稳定实例 ID `article-{articleId}`。Cloudflare 实例 ID 只允许 ASCII 字母、数字、下划线和连字符，不能直接使用中文文章标题。批量启动失败时删除本轮新增的 D1 去重行，使下一轮能够重试。
- R2 和 AI Search 使用同一对象键；写入均按同键幂等覆盖。R2 保留原始 Markdown，中文标点后加空格的兼容修复仅在上传 AI Search 时应用。

Cron Trigger 使用 UTC：

```text
*/5 0-9 * * MON-FRI
```

对应北京时间工作日 08:00–17:55，即在 `[08:00, 18:00)` 时段内每 5 分钟执行。

## 本地验证

```bash
pnpm install
pnpm types
pnpm db:migrate:local
pnpm check
pnpm test
pnpm deploy:dry
```

## AI Search 元数据补全

`scripts/reprocess-missing-ai-search-metadata.ts` 用于维护 AI Search `default/finance` 中缺少
`published_at`、`source`、`tags` 或 `importance` 的内置存储文章。脚本按每页最多 50 条遍历
线上 Items，以和生产 Workflow 相同的 R2 key 规则精确映射 D1 文章；默认只盘点，不写入：

```bash
CLOUDFLARE_API_TOKEN=... pnpm maintenance:repair-metadata
```

确认盘点结果后，显式传入 `--execute`。脚本按受控并发为每篇文章创建新的 `article`
Workflow 实例，等待执行结束，并重新分页检查四个元数据字段；任一 Workflow 失败、字段仍缺失、
映射不唯一或 Item 尚在处理中都会以非零状态结束：

```bash
CLOUDFLARE_API_TOKEN=... pnpm maintenance:repair-metadata -- --execute --concurrency 4
```

Token 只从 `CLOUDFLARE_API_TOKEN` 环境变量读取，不写配置或日志；需要 AI Search Edit/Run、
D1 Read 和 Workers Scripts Write 权限。账户、D1、AI Search 和 Workflow 标识默认从
`wrangler.jsonc` 读取，也可通过 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、
`AI_SEARCH_INSTANCE`、`ARTICLE_WORKFLOW_NAME` 环境变量覆盖。

如果 token 只有 AI Search Edit/Run 权限，可用 `--wrangler-auth` 让 D1 查询与 Workflow
管理改用本机已登录的 Wrangler OAuth。Wrangler 子进程会主动移除 `CLOUDFLARE_API_TOKEN`，
避免权限不足的 API token 覆盖 OAuth 身份：

```bash
node --env-file=../.env --import tsx scripts/reprocess-missing-ai-search-metadata.ts --wrangler-auth
node --env-file=../.env --import tsx scripts/reprocess-missing-ai-search-metadata.ts --wrangler-auth --execute
```

维护重跑使用 DM 已清洗的正文，只复用现有逻辑删除 Markdown 图片、链接 URL（保留锚文本），
不再下载公众号原文，也不会再次执行风险提示截断。随后仍完整执行特征抽取、D1 特征和关键词覆盖、
R2 同 key 覆盖及 AI Search 元数据 upsert。常规增量 Workflow 的公众号下载与风险披露处理不变。

## Cloudflare 初始化与自动部署

以下资源命令仅用于首次初始化；日常发布只需推送 `main`。Wrangler v4.45+ 可以自动配置缺少资源 ID 的 D1 binding，首次初始化建议显式创建同名 D1：

```bash
pnpm exec wrangler whoami
pnpm exec wrangler secret put CF_AIG_TOKEN
pnpm exec wrangler d1 create eastmoney --location apac
pnpm db:migrate:remote
pnpm exec wrangler r2 bucket info article
git push origin main
```

如果 `wrangler d1 create eastmoney` 把 `database_id` 自动写回 `wrangler.jsonc`，应保留该配置。项目已配置 Cloudflare Git 自动构建和部署，推送 `main` 后由平台完成发布，不手动运行 `pnpm deploy:worker`。旧 `ingest` D1 仅作为迁移回退副本保留，不再绑定到 Worker。
