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
- `pnpm check` 同时检查 Worker 与维护脚本 TypeScript。
- `pnpm test` 使用 Vitest Workers pool，不访问真实生产资源。
- `pnpm deploy:dry` 验证打包与绑定，不发布 Worker。

## 维护脚本

默认只盘点缺失 AI Search 元数据：

```bash
pnpm maintenance:repair-metadata
```

显式 `--execute` 会创建 Workflow 并写 D1、R2 与 AI Search：

```bash
CLOUDFLARE_API_TOKEN=... pnpm maintenance:repair-metadata -- --execute --concurrency 4
```

也可用 Wrangler OAuth 承担 D1 和 Workflow 权限：

```bash
node --env-file=../.env --import tsx scripts/reprocess-missing-ai-search-metadata.ts --wrangler-auth
```

执行前先确认账户、D1、AI Search、Workflow、盘点数量和 token 权限。执行后必须等待所有 Workflow 完成，并重新分页核对缺失字段和错误项。

## 资源初始化

以下命令只用于首次配置或明确的迁移任务，不属于日常发布：

```bash
pnpm exec wrangler whoami
pnpm exec wrangler d1 create eastmoney --location apac
pnpm db:migrate:remote
pnpm exec wrangler r2 bucket info article
```

资源名称和 binding 以 `wrangler.jsonc` 为事实来源。

## Git 与发布

- 仓库默认分支为 `main`；开始前检查工作区并保留用户已有改动。
- 完成默认验证后提交并推送 `main`，由 Cloudflare Git 自动构建和部署。
- 不手动运行 `pnpm deploy:worker`，除非用户明确覆盖自动部署约定。
- 推送后需要发布确认时，检查 Cloudflare 构建和 Worker 健康状态；`git push` 成功本身不等于线上部署完成。

## 文档维护

- 新命令或交付流程更新本文件。
- Workflow 或模块边界更新 `ARCHITECTURE.md`。
- D1、幂等与 migration 更新 `DATABASE.md`。
- Secret、权限或外部校验更新 `SECURITY.md`。
