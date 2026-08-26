# AGENTS.md

## Project Overview

纯 TypeScript Cloudflare Worker。Cron 在工作日北京时间 08:00–18:00 每 5 分钟读取 `市场解读` 文章，只为新增记录创建 `ArticleWorkflow`，完成正文获取、AI 特征抽取、D1 元数据、R2 归档与 AI Search 索引。

运行资源以 `wrangler.jsonc` 为准：Worker `ingest`、D1 `eastmoney`、Workflow `article`、R2 `article`、AI Search `finance`。

## Repository Structure

- `src/index.ts`：Worker fetch/scheduled 入口与 `ArticleWorkflow`。
- `src/article.ts`：外部文章 API 契约、校验、Markdown 与稳定 key。
- `src/ingest.ts`：批量查重、仅新增写入、Workflow 启动和失败回滚。
- `src/wechat.ts`：公众号直连下载、Markdown 转换和风险披露清洗。
- `src/feature-extraction.ts`：结构化特征 Schema、Prompt 和 D1 写入。
- `src/ai-gateway.ts`、`src/ai-search.ts`：AI Gateway 与 AI Search 适配器。
- `migrations/`：D1 migration。
- `tests/`：Vitest / Workers runtime 测试。

## Mandatory Rules

- 项目必须保持纯 TypeScript；不得新增 Python、本地采集器、SQLite 或 launchd 任务。
- 修改前搜索现有 adapter、校验器和测试；不要绕过 `article.ts`、`ai-gateway.ts` 或既有 Workflow 步骤直接实现重复逻辑。
- Cron 固定为 `*/5 0-9 * * MON-FRI`（UTC），即北京时间工作日 `[08:00, 18:00)` 每 5 分钟。
- 列表固定请求 `tag=市场解读&pageSize=100`，并再次执行精确标签过滤。
- `ARTICLE_API_BASE_URL` 固定为 `https://eastmoney.hasbai.xyz/data`，统一读取 `/data/news` 与详情路由。
- 每轮 D1 批量查重；重复轮询不得更新已有记录。新增项一次 `batch()` 写入，Workflow 批量启动失败时删除本轮新增去重行以便重试。
- Workflow 步骤必须幂等，所有 Promise 必须 await。公众号直连失败时回退 DM 正文。
- 正文不写 D1。D1 只保存文章元数据、结构化特征和关键词；R2 保存未经 AI Search 标点兼容修复的 Markdown。
- R2 与 AI Search key 固定为 `yyyy-mm-dd/标题.md`。中文标点补空格只能在写 AI Search 前应用。
- 生成式 AI 只通过 `src/ai-gateway.ts` 调用自定义 Provider 的原生 Responses API；固定优先 `custom-opencode`，可重试失败时回退 `custom-codex`，`dynamic/rag` 只保留在项目组 `AI.md` 作为历史兼容路线。Zod Schema 是结构化输出唯一来源，应用端必须校验，输入和有效输出不得截断。
- 外部 API 响应必须限长读取并做运行时校验；不得直接断言为业务类型。
- Cloudflare 资源优先使用 binding；自定义 Provider Responses 必须使用 provider-specific Gateway URL，不能使用会进入 Universal 适配层的 AI binding `run()`。AI Gateway token 只使用 Worker Secret `CF_AIG_TOKEN`。
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

不要默认读取全部文档。按任务选择：

- Cron、Workflow、模块依赖、R2/AI Search 数据流 → `docs/ARCHITECTURE.md`
- D1 表、去重、特征覆盖、migration → `docs/DATABASE.md`
- Secret、外部响应、日志、维护脚本权限 → `docs/SECURITY.md`
- 本地命令、测试、维护盘点、Git 与自动部署 → `docs/DEVELOPMENT.md`

Do not load all documentation by default. Read only documentation relevant to the current task. If multiple areas are affected, read only the corresponding documents. Do not repeatedly read documents already available in the current context unless necessary.
