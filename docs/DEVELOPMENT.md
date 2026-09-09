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
- `article` Workflow 由研报采集按文章创建实例；现有 Worker Cron 先抓取、去重央行资讯，仅在有新增时为整批创建一个 `telegram` Workflow，不使用仅付费 Workers 计划可用的 Workflow schedule。两者都可在 Cloudflare Workflow 实例中逐步排查。

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

`article-cleanup` 是手动维护 Workflow，不接入 Cron，也不重跑 AI 特征抽取或写 D1。新归档由共同的 `prepareAiSearchMarkdown` 自动清洗。

1. 全量列出 R2 `article` 的对象，下载 `report/` 正文并备份自定义元数据、HTTP 元数据、ETag 和正文哈希到 Git 忽略的 `var/`；核对下载正文 MD5 与对象 ETag。历史含 `?` 的 key 若管理 API 下载失败，只能使用与当前 ETag 一致的已验证备份，不能跳过哈希校验。
2. 使用当前 `prepareAiSearchMarkdown` 生成清洗预览，检查正文保留、空正文/纯图片文章、残留语法与幂等性；只将有变化的对象加入执行清单。
3. 每批至多 25 篇，参数为 `{"items":[{"key":"report/yyyy-mm-dd/标题.md","etag":"备份时的32位ETag"}]}`。通过 `pnpm exec wrangler workflows trigger article-cleanup '<参数JSON>' --id <批次ID>` 或同等管理 API 启动；不得绕过备份直接列举并覆盖全部对象。
4. 等待实例 `complete`，再全量复核 R2 正文哈希、原发布时间及全部自定义/HTTP 元数据；确认每个目标等于预览，非目标对象未变化，并保存验收记录。失败/并发变化须重新备份和审查，不盲目重试覆盖。
5. AI Search 独立同步更新后的对象；R2 清洗完成与索引完成分别记录。

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
