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

## AI Search 到 R2 存量回填

`ArticleArchiveMigrationWorkflow` / `article-archive-migration` 仅由维护任务手动触发，Cron 不调用它。每批最多 50 个 `{ itemId, key, r2Key }`：从 `finance` 内置存储读取正文，以原 key 写入 R2 `article`，补齐 `source`、`tags`、`importance`、`type`、`published_at` 元数据。迁移不写 D1，不删除 AI Search Item。

已有 R2 正文优先保留；逐项核对正文，仅允许既有中文标点空格差异，发现实质冲突立即停止该批。历史上传将引号编码为 `%22` 的 key，只允许映射到已存在且正文一致的原始引号 key。R2 写入使用 ETag 条件防止覆盖并发更新，并读回检查元数据。

迁移前需保存完整 Item 清单、原始正文及原 R2 对象备份。先回填，再等待 R2 来源索引全部 `completed`、检查原始发布日期过滤和检索内容，最后才允许清理内置副本。数据源连接是否生效，以同步任务实际生成 R2 来源 Item 为准。

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
