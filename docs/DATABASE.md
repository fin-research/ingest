# D1 数据规则

D1 绑定为 `DB`，数据库名 `eastmoney`。最终 schema 以 `migrations/` 按顺序执行后的结果为事实来源。

## `article`

- `id`：文章主键，也是增量去重依据。
- `news_id`：上游兼容 ID。
- `title`、`published_at`：文章标识与发布时间。
- `created_at`、`updated_at`：发现和更新时点，使用 ISO 字符串。
- `link`：幂等补充的原文链接。
- `author`、`summary`、`importance`、`prompt_version`：经过 Schema 校验的结构化特征。

正文、R2 内容、AI Search 状态和原始上游 JSON 不写入 D1。

## `keyword`

- 主键 `(article_id, ordinal)`；外键删除文章时级联清理。
- 保存 `topic`、`fact`、`interpretation`、`impact`。
- 同一文章重跑抽取时，使用一个 D1 `batch()` 删除旧关键词并写入新特征与新关键词，避免半更新。

## `telegram_delivery`

- `article_id`：已成功推送的 DM `sentimentId`，也是投递去重主键。
- `title`、`published_at`：当时发送的资讯标识与发布时间。
- `sent_at`、`telegram_message_id`：Telegram 成功响应后的投递时间和消息 ID。
- 只有标题严格以 `中国央行：` 开头且精确包含 `经济数据&政策` 标签的资讯才会写入。
- 先发送、成功后记录；写 D1 失败时下轮可能重复发送，但不会把未发送资讯误记为成功。

## 写入规则

- 轮询先用一个 `IN (...)` 批量查询现有 ID。
- 新记录使用准备好的 insert statement 和一次 `batch()`；`ON CONFLICT(id) DO NOTHING` 处理并发重复发现。
- 已存在文章在普通轮询中不更新，避免每五分钟写放大。
- Workflow 批量启动失败时删除本轮实际新增的 ID，使下轮可以重试。
- 文章 link 只有为空或发生变化时更新。
- Telegram 告警按 `telegram_delivery.article_id` 去重，不写入 `article`，也不启动文章 Workflow。

## Migration

- 所有 D1 结构变化新增 migration，不改写历史文件。
- 运行 `pnpm db:migrate:local` 后执行全部测试。
- 远端使用 `pnpm db:migrate:remote`，只在明确的 schema 交付任务中执行。
- `dashboard` 读取同一生产 D1 的文章与关键词。字段或约束变化必须同步检查其本地镜像 migration、同步脚本和热点证据查询。

## R2 与 AI Search

R2 保存原始清洗后的 Markdown；AI Search 保存仅增加标点空格兼容修复的版本。两者使用相同 key，但内容职责不同，不能用 AI Search 兼容文本回写覆盖 R2。
