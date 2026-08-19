# AGENTS.md

## Build & Run

- 项目必须保持纯 TypeScript，不得新增 Python、本地采集器或 launchd 任务。
- 依赖与命令统一使用 `pnpm`：`pnpm install`、`pnpm types`、`pnpm check`、`pnpm test`。
- Wrangler 必须为 v4；配置使用 `wrangler.jsonc`。项目已配置 Cloudflare Git 自动构建和部署，完成验证后提交并推送 `main`，不得手动运行 `pnpm deploy:worker`。
- Worker 固定名为 `ingest`，D1 数据库固定名为 `eastmoney`；R2 存储桶固定为 `article`，Workflow 名固定为 `article`，AI Search 固定为 `default/finance`。
- 公网 API 基址通过非敏感环境变量 `ARTICLE_API_BASE_URL` 配置，生产值固定为 `https://eastmoney.hasbai.xyz/api`。
- 本地 D1 迁移使用 `pnpm db:migrate:local`；远端迁移使用 `pnpm db:migrate:remote`。

## Structure

- `src/article.ts`：`/api/news` 列表/正文契约、输入校验、Markdown 和 R2 路径生成。
- `src/wechat.ts`：复用 `kb/src/services/wechat.ts`、`content.ts` 与 `article-cleaning.ts` 的公众号直连下载、HTML 转 Markdown 和风险披露清洗逻辑。
- `src/ingest.ts`：D1 批量去重、仅新增写入、Workflow 批量启动及失败回滚。
- `src/index.ts`：Cron 与 `/health` Worker 入口、`ArticleWorkflow`。
- `migrations/`：D1 schema，只保存 ID 与文章元数据，不保存正文。
- `tests/`：Worker TypeScript 单元测试。

## Boundaries

- 不得恢复微信渠道、`/api/wechat-articles`、本地 SQLite、Python collector、Bearer ingest endpoint 或 LaunchAgent。
- Cron 固定为 `*/5 0-9 * * MON-FRI`（UTC），对应北京时间工作日 `[08:00, 18:00)` 每 5 分钟。
- 列表固定请求 `/api/news?tag=市场解读&pageSize=100`；必须再次按精确标签防御性过滤。
- 每轮 D1 使用批量查重；重复轮询不得更新已有记录。新增记录使用一次 `batch()`，避免逐篇网络往返和写放大。
- Workflow 在下载和归档之间固定增加特征抽取与 D1 存储步骤，随后写 R2、写 AI Search；若原文是 `mp.weixin.qq.com`，在获取详情后增加独立的公众号下载步骤。获取 DM 详情时把原文 `link` 幂等写入 D1；公众号步骤优先直连下载并按 kb 口径转换 Markdown，再删除图片与链接 URL（链接锚文本保留），并清除风险披露及后文；下载或解析失败则使用 DM 正文。特征抽取通过 AI Gateway `compat/chat/completions` 调用 `dynamic/rag` 动态路由，关闭 thinking 与缓存并记录日志；输入和有效输出不得截断。步骤必须幂等，所有 Promise 必须 await。
- R2 路径与 AI Search key 固定为 `yyyy-mm-dd/标题.md`；正文不得写入 D1，D1 只保存文章元数据、结构化特征和关键词。
- 中文标点后加空格只是 AI Search 解析兼容修复，只能在写 AI Search 前应用；R2 保存未经该修复的正文。
- D1、R2、Workflow 与 AI Search 等 Cloudflare 资源优先使用 binding。AI Gateway 动态路由是明确例外：生产认证只允许使用 Worker Secret `CF_AIG_TOKEN`，账户 ID 与 Gateway ID 使用非敏感变量，token 不得写入源码或 `wrangler.jsonc`。`compat` 端点虽已被 Cloudflare 标记为 deprecated，但它是当前已验证同时兼容动态路由内第三方 provider 与 Workers AI 节点的路径；迁移到新版 REST API 前必须先完成同等线上兼容性验证。
- 外部 API 响应必须限长读取并运行时校验；不得把响应直接断言成业务类型。

## Verification

1. `pnpm install`
2. `pnpm types`
3. `pnpm db:migrate:local`
4. `pnpm check`
5. `pnpm test`
6. `pnpm deploy:dry`
7. 提交并推送 `main`，由 Cloudflare Git 自动构建和部署；不要手动部署。
