# AGENTS.md

## Project Overview

纯 TypeScript Cloudflare Worker。Cron 在工作日北京时间 08:00–18:00 每 5 分钟读取 `市场解读` 文章和 `中央政策` 资讯；新增研报进入 `ArticleWorkflow` 完成正文获取、AI 特征抽取、D1 元数据、R2 归档和政策关联；AI Search 独立同步 R2 数据源，新增政策资讯进入 `PolicyWorkflow` 自动归并为政策卡片。

运行资源以 `wrangler.jsonc` 为准：Worker `ingest`、D1 `eastmoney`、四个业务 Workflow 和 R2 `article`。AI Search `research` 独立同步 R2，Worker 不绑定 AI Search。

## Mandatory Rules

- 项目必须保持纯 TypeScript；不得新增 Python、本地采集器、SQLite 或 launchd 任务。
- 修改前搜索现有 adapter、校验器和测试；不要绕过 `article.ts`、`ai-gateway.ts` 或既有 Workflow 步骤直接实现重复逻辑。
- 工作日采集 Cron 和 09:20 的公开市场播报使用 `wrangler.jsonc` 中的既有调度；步骤与重试规则见[公开市场播报](docs/modules/open-market.md)。
- 列表固定请求 `tag=市场解读&pageSize=100`，并再次执行精确标签过滤。
- 政策列表固定请求 `tag=中央政策&pageSize=100`，并再次执行精确标签过滤；政策归并必须由 `PolicyWorkflow` 完成。
- `ARTICLE_API_BASE_URL` 固定为 `https://eastmoney.hasbai.xyz/data`，统一读取 `/data/news` 与详情路由。
- 所有 Data 列表和详情通过 `src/data-fetcher.ts` 使用 `DATA` / `InternalData` Service Binding；发布前确认 Data Worker 已提供该入口，不以公网请求绕过登录保护。
- `/data/news` 是顶层 JSON array；请求必须用 `fields` 只取 `sentimentId,newsId,title,time,tags`，公开市场播报不按 `important` 筛选；不得恢复 `list` 或 `data` envelope 假设。详情仍为顶层 object。
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

跨项目执行与工作树规则见 [项目组 AGENTS](../eastmoney/AGENTS.md)，未在上下文中时读取一次。按任务选读：Cron、DATA 契约和 Workflow 启动读 [ARCHITECTURE](docs/ARCHITECTURE.md)；研报正文、公众号、特征与归档读[研报模块](docs/modules/articles.md)；政策队列、归并和研报关联读[政策模块](docs/modules/policies.md)；公开市场操作播报读[公开市场播报](docs/modules/open-market.md)；央行资讯与 Telegram 读[通知模块](docs/modules/telegram.md)。D1 幂等/migration 加读 [DATABASE](docs/DATABASE.md)，Secret/日志加读 [SECURITY](docs/SECURITY.md)，验证与 Git 自动部署加读 [DEVELOPMENT](docs/DEVELOPMENT.md)。

跨服务变化才读 [共享架构](../eastmoney/docs/ARCHITECTURE.md)，共享表或归档变化才读 [共享数据库](../eastmoney/docs/DATABASE.md)，AI 变化才读 [共享 AI](../eastmoney/docs/AI.md)。不要默认读全量文档，跨模块仅加读受影响部分，不重复读取已有上下文。

## 权限测试

共享认证架构、各权限范围及测试账号配置见 [项目组 AUTH](../eastmoney/docs/AUTH.md)。权限登录与验收只使用程序化 HTTP、单元测试与 CLI，禁止 browser、Chrome、Playwright 和浏览器 MCP。新增测试仅使用匿名和 `test@18.cn` 两种身份；真实密码只读根目录 `.env`，不进入测试夹具或日志。

## 测试规范

测试新增、合并、覆盖率与视觉回归按 [TESTING](docs/TESTING.md) 执行；不要通过源码样式或控件数量锁定代替行为验证。
