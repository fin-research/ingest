# 开发、维护与发布

## 本地验证

```bash
pnpm install
pnpm types
pnpm db:migrate:local
pnpm check
pnpm test
pnpm deploy:dry
git diff --check
```

- `pnpm types` 根据 `wrangler.jsonc` 更新 Worker binding 类型。
- `pnpm check` 检查 Worker TypeScript 与生成的 binding 类型。
- `pnpm test` 使用 Vitest Workers pool，不访问真实生产资源。
- `pnpm deploy:dry` 验证打包与绑定，不发布 Worker。
- `omo` Workflow 由现有 Cron 在工作日北京时间 09:20 创建并执行，日实例去重；固定两个业务 step，失败用 Workflow 原生 15 秒重试（最多 20 次），重试耗尽失败，不设 09:25 截止；结果由 Messenger 订阅平台事件后统一 email＋Telegram。
- `article` Workflow 由研报采集按文章创建实例；现有 Worker Cron 先抓取、去重央行资讯，仅在有新增时为整批创建一个 `telegram` Workflow，保留由新增数据驱动的创建方式。两者都可在 Cloudflare Workflow 实例中逐步排查。

### 原生 Workflow Schedule 核验

2026-09-21 使用独立、无业务绑定的临时 Workflow 实测原生 `schedules`。本地 dry-run 成功，但实际创建 schedule 被 Cloudflare 拒绝：HTTP `403`、code `10208`、`workflows.api.error.workflow.cron_requires_paid_plan`。当前账号须启用 Workers 付费计划后才能使用；本次未修改套餐。临时 Worker 和 Workflow 已删除。生产继续使用现有 Worker Cron；未将配置可解析视为线上调度成功。

## 资源初始化

以下命令只用于首次配置或明确的迁移任务，不属于日常发布：

```bash
pnpm exec wrangler whoami
pnpm exec wrangler secret put CF_AIG_TOKEN
pnpm exec wrangler d1 create eastmoney --location apac
pnpm db:migrate:remote
pnpm exec wrangler r2 bucket info article
```

资源名称和 binding 以 `wrangler.jsonc` 为事实来源。

## R2 与 AI Search 验收

- 日常归档只使用 R2 article 的 report/ 与 policy/，type 分别为文本研报、政策。
- AI Search research 独立同步两个目录；Worker 不绑定或调用 AI Search。
- R2 归档状态与索引状态分别检查，检索日期使用原始 published_at。
- 一次性迁移工具及 Workflow 已退役，迁移备份和验收记录保留在本地 var/research-migration-20260907/，不提交 Git。

## 历史研报正文清洗

`article-cleanup` 已退役，不再提供在线维护 Workflow。新归档仍由共同的 `prepareAiSearchMarkdown` 自动清洗，历史备份保留。

2026-09-09 清洗的原文、清单、预览和执行证据保存在本地 `var/article-cleanup-20260909/`，不提交正文或凭证。

## Git 与发布

- 仓库默认分支为 `main`；开始前检查工作区并保留用户已有改动。
- 完成默认验证后提交并推送 `main`，由 Cloudflare Git 自动构建和部署。
- 不手动运行 `pnpm deploy:worker`，除非用户明确覆盖自动部署约定。
- 推送后需要发布确认时，检查 Cloudflare 构建和 Worker 健康状态；`git push` 成功本身不等于线上部署完成。

## 文档维护

- 新命令或交付流程更新本文件。
- 调度依赖更新 `ARCHITECTURE.md`，Workflow 步骤更新目标模块；新增模块更新 [INDEX](INDEX.md)。
- D1 幂等与 migration 更新 `DATABASE.md`；跨仓库表、归档协议与 AI 变更更新 [项目组所有方](../../eastmoney/docs/INDEX.md#维护约定)。
- Secret、权限或外部校验更新 `SECURITY.md`。

## 权限专项验证

按 [共享 AUTH](../../eastmoney/docs/AUTH.md#程序化权限测试) 执行本仓库匿名/测试账号覆盖。权限验收禁止 browser；真实登录统一使用 Dashboard 的 `pnpm auth:verify`，凭据只从项目组根 `.env` 读取，不复制登录实现或密码到各仓库。

## 测试分层与覆盖率

测试规范、覆盖率口径、当前审计及专项入口见 [TESTING](TESTING.md)。
