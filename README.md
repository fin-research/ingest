# 研报文章增量采集

`ingest` 是纯 TypeScript Cloudflare Worker。Cron 在工作日北京时间 08:00–18:00 时段内每 5 分钟调用公网数据 API，读取 `tag=市场解读` 的研报列表，以 D1 主键批量去重，只把新增文章交给固定的 `article` Workflow。

Workflow 每篇文章执行三个基础步骤；微信公众号文章会多执行一个可重试步骤：

1. 通过 `/api/news/{sentimentId}` 获取文章全文和原文链接；缺少 `sentimentId` 时回退到 `newsId`，并在同一步把原文链接幂等写入 D1。
2. 若链接指向微信公众号，单独执行公众号直连下载、HTML 转 Markdown 与风险披露清洗，并删除图片及链接 URL（保留链接锚文本）；失败时回退到 DM 正文。
3. 写入 R2 `article` 存储桶，键为 `yyyy-mm-dd/标题.md`。
4. 从 R2 读取同一对象并上传到 AI Search `default/finance`。

## 数据与写入策略

- 数据源环境变量：`ARTICLE_API_BASE_URL=https://eastmoney.hasbai.xyz/api`。
- 列表请求：`GET /news?tag=市场解读&pageSize=100`。
- D1 数据库与 Worker 均名为 `ingest`；D1 保存文章 ID、标题、发布时间、发现时间和详情中的原文 `link` 等元数据，不保存正文。
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

## Cloudflare 初始化与部署

Wrangler v4.45+ 可以自动配置缺少资源 ID 的 D1 binding。首次部署建议显式创建同名 D1，避免 Worker 已启用 Cron 但远端表尚未迁移：

```bash
pnpm exec wrangler whoami
pnpm exec wrangler d1 create ingest
pnpm db:migrate:remote
pnpm exec wrangler r2 bucket info article
pnpm deploy:worker
curl https://ingest.hasbai.workers.dev/health
```

如果 `wrangler d1 create ingest` 把 `database_id` 自动写回 `wrangler.jsonc`，应保留该配置。部署后 Cron Trigger 可能需要约 15 分钟在全球生效。
