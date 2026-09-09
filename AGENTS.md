# AGENTS.md

## Project Overview

纯 TypeScript Cloudflare Worker。Cron 在工作日北京时间 08:00–18:00 每 5 分钟读取 `市场解读` 文章和 `中央政策` 资讯；新增研报进入 `ArticleWorkflow` 完成正文获取、AI 特征抽取、D1 元数据、R2 归档和政策关联；AI Search 独立同步 R2 数据源，新增政策资讯进入 `PolicyWorkflow` 自动归并为政策卡片。

运行资源以 `wrangler.jsonc` 为准：Worker `ingest`、D1 `eastmoney`、三个业务 Workflow、手动归档维护 Workflow 和 R2 `article`。AI Search `research` 独立同步 R2，Worker 不绑定 AI Search。

## Repository Structure

- `src/index.ts`：Worker fetch/scheduled 入口与 Article、Telegram、Policy 三类 Workflow。
- `src/article.ts`：外部文章 API 契约、校验、Markdown 与稳定 key。
- `src/ingest.ts`：批量查重、仅新增写入、Workflow 启动和失败回滚。
- `src/policy.ts`：中央政策队列认领、AI 聚合、双向研报关联和 D1 写入。
- `src/wechat.ts`：公众号直连下载、Markdown 转换和风险披露清洗。
- `src/markdown-cleanup.ts`：归档头部、Markdown 图片与链接清洗；保留链接文字与正文格式。
- `src/archive-cleanup.ts`：按备份清单和 ETag 手动清洗历史研报，保留 R2 元数据，不由 Cron 触发。
- `src/feature-extraction.ts`：结构化特征 Schema、Prompt 和 D1 写入。
- `src/ai-gateway.ts`：AI Gateway 适配器。
- `src/policy-archive.ts`：PolicyWorkflow 使用的政策 Markdown、元数据与 R2 归档。
- `migrations/`：D1 migration。
- `tests/`：Vitest / Workers runtime 测试。

## Mandatory Rules

- 项目必须保持纯 TypeScript；不得新增 Python、本地采集器、SQLite 或 launchd 任务。
- 修改前搜索现有 adapter、校验器和测试；不要绕过 `article.ts`、`ai-gateway.ts` 或既有 Workflow 步骤直接实现重复逻辑。
- Cron 固定为 `*/5 0-9 * * MON-FRI`（UTC），即北京时间工作日 `[08:00, 18:00)` 每 5 分钟。
- 列表固定请求 `tag=市场解读&pageSize=100`，并再次执行精确标签过滤。
- 政策列表固定请求 `tag=中央政策&pageSize=100`，并再次执行精确标签过滤；政策归并必须由 `PolicyWorkflow` 完成。
- `ARTICLE_API_BASE_URL` 固定为 `https://eastmoney.hasbai.xyz/data`，统一读取 `/data/news` 与详情路由。
- 所有 Data 列表和详情通过 `src/data-fetcher.ts` 使用 `DATA` / `InternalData` Service Binding；发布前确认 Data Worker 已提供该入口，不以公网请求绕过登录保护。
- `/data/news` 是顶层 JSON array；请求必须用 `fields` 只取 `sentimentId,newsId,title,time,tags`，不得恢复 `list` 或 `data` envelope 假设。详情仍为顶层 object。
- 每轮 D1 批量查重；重复轮询不得更新已有记录。新增项一次 `batch()` 写入，Workflow 批量启动失败时删除本轮新增去重行以便重试。
- Workflow 步骤必须幂等，所有 Promise 必须 await。公众号直连失败时回退 DM 正文。
- 政策与研报关联使用双向增量触发：政策落库时匹配已有研报，研报特征落库时匹配近期政策；人工关联或排除优先于 AI，后续自动任务不得覆盖。
- 研报正文不写 D1；政策正文继续保留在 `policy_news` 供详情与点评读取。R2 保存两类用于索引的 Markdown，写入前统一应用既有中文标点补空格兼容处理。
- R2 key、元数据和 AI Search 独立索引遵循 [共享归档协议](../eastmoney/docs/DATABASE.md#研究归档协议)，两类归档复用既有 adapter。
- 生成式 AI 只通过 `src/ai-gateway.ts`，传输/重试/检索规则见 [共享 AI](../eastmoney/docs/AI.md)。Prompt 与 Zod Schema 留在特征和政策模块。
- 外部 API 响应必须限长读取并做运行时校验；不得直接断言为业务类型。
- Cloudflare 资源优先使用 binding；AI Gateway 的凭据和日志遵循共享 AI，Telegram Secrets Store 规则见 [SECURITY](docs/SECURITY.md)。
- 不手动编辑 `worker-configuration.d.ts`；使用 `pnpm types`。
- 保留用户已有改动，包括与任务无关的工作区文件；不要回退或吸收 `.DS_Store` 等既有差异。
- 默认交付完成验证后提交并推送 `main`，由 Cloudflare Git 自动构建部署；不得手动运行 `pnpm deploy:worker`。

## Commands

- 安装：`pnpm install`
- Worker 类型：`pnpm types`
- D1 本地 migration：`pnpm db:migrate:local`
- 检查：`pnpm check`
- 测试：`pnpm test`
- 部署 dry-run：`pnpm deploy:dry`
- D1 远端 migration：`pnpm db:migrate:remote`

## Context Routing

跨项目执行与工作树规则见 [项目组 AGENTS](../eastmoney/AGENTS.md)，未在上下文中时读取一次。先按 [docs/INDEX.md](docs/INDEX.md) 选择研报、政策、Telegram 或调度模块，再按影响加读 DATABASE、SECURITY、DEVELOPMENT。

跨服务变化才读 [共享架构](../eastmoney/docs/ARCHITECTURE.md)，共享表或归档变化才读 [共享数据库](../eastmoney/docs/DATABASE.md)，AI 变化才读 [共享 AI](../eastmoney/docs/AI.md)。不要默认读全量文档，跨模块仅加读受影响部分，不重复读取已有上下文。

## 权限测试

共享认证架构、各权限范围及测试账号配置见 [项目组 AUTH](../eastmoney/docs/AUTH.md)。权限登录与验收只使用程序化 HTTP、单元测试与 CLI，禁止 browser、Chrome、Playwright 和浏览器 MCP。新增测试仅使用匿名和 `test@18.cn` 两种身份；真实密码只读根目录 `.env`，不进入测试夹具或日志。
