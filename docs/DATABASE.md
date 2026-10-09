# D1 数据规则

D1 schema 以 [migrations](../migrations) 为事实来源。本文件只维护 Ingest 表粒度、幂等和写入步骤；生产共享表所有权与两仓库迁移协同见 [共享数据库](../../eastmoney/docs/DATABASE.md#共享-d1)。

## `article`

- `id`：文章主键；增量同时按标题首尾空白归一化与上海自然日去重。
- `news_id`：上游兼容 ID。
- `title`、`published_at`：文章标识与发布时间。
- `created_at`、`updated_at`：发现和更新时点，使用 ISO 字符串。
- `link`：幂等补充的原文链接。
- `author`、`summary`、`importance`、`prompt_version`：经过 Schema 校验的结构化特征。

研报正文、R2 内容、AI Search 状态和原始上游 JSON 不写入 D1。政策正文保留在 `policy_news` 供详情与点评读取。

## `keyword`

- 主键 `(article_id, ordinal)`；外键删除文章时级联清理。
- 保存 `topic`、`fact`、`interpretation`、`impact`。
- 同一文章重跑抽取时，使用一个 D1 `batch()` 删除旧关键词并写入新特征与新关键词，避免半更新。

## `telegram_delivery`

- `article_id`：待发送或已成功推送的 DM `sentimentId`，也是抓取去重主键。
- `title`、`published_at`：当时发送的资讯标识与发布时间。
- `discovered_at`：Cron 首次发现并由 Workflow 入库的时间。
- `workflow_instance_id`：首次成功入库该资讯的 Telegram Workflow；并发实例不能发送不属于自己的记录。
- `sent_at`、`telegram_message_id`：历史直发记录的成功时间和 Telegram 消息 ID；迁移后新记录保持为空。
- `messenger_id`、`submitted_at`：提交给 messenger 后写入的提交 ID 和时间；不代表 Telegram 已发送。
- 只有标题以 `中国央行：` 开头且精确包含 `经济数据&政策` 标签的资讯才会写入；全角冒号属于匹配前缀，不能省略或替换为半角冒号。
- Workflow 第一步先写待发送记录，第二步提交 messenger 并更新提交字段。第二步重试时查询已有 Telegram 消息 ID 或 messenger 提交 ID 并跳过已完成记录；最终发送状态由 messenger 管理。

## 写入规则

- 轮询以每组20个候选查询现有ID和候选日期、标题，避免D1参数上限；不读取正文。
- Cron去重后直接每批最多100条元数据启动Workflow，不在采集端预占D1记录。
- ArticleWorkflow第一步使用 `INSERT … SELECT … WHERE NOT EXISTS` 原子保护标题/上海自然日，`ON CONFLICT(id) DO NOTHING` 保护ID。相同ID步骤重试可继续，不同ID重复则结束Workflow；不修改已有元数据。无需改schema或清理历史重复。
- 已存在文章在普通轮询中不更新，避免每五分钟写放大；不扫描未特征化记录，不对账、自动恢复或重启已有实例。
- Workflow内订阅首次insert保存列表长link；news首次insert不保存link，仍由旧详情步骤补充。正文在Workflow内读取，不作为启动参数、不写D1。
- 元数据已保存后，明确空字符串或纯空白正文正常跳过且不触发失败告警，最终接口失败仍保留记录供普通列表查重；Workflow步骤内有限重试耗尽后按需人工处理。
- 文章 link 只有为空或发生变化时更新。
- Telegram 抓取在 Workflow 外按 `telegram_delivery.article_id` 去重；无新增时不创建 Workflow。新增批次只创建一个 Telegram Workflow，并依次执行“入库”“发送”两个可重试步骤。

## 政策跟踪

- `policy_event`：一条已归并政策事件或政策包，保存规范标题、累计摘要、累计发布部门、政策日期、首末资讯时间和 `importance`。重要性以境内资金面、货币市场和利率影响为中心，枚举为 `important`（重要）、`related`（关联）、`general`（一般）；不同正式文件若属于同一集中发布的一揽子安排，不按文件拆卡。
- `policy_news`：`中央政策` 标签资讯队列及政策证据；抓取后先以 `pending` 入库并由 Workflow 认领，聚合完成后变为 `grouped` 且必须关联一个 `policy_event`。超时认领可由后续 Cron 重新接管。
- `policy_article`：政策与 article 的多对多关系，只保存关系状态、关联方式和时间戳，不保存模型置信度或关联理由；`manual` 表示人工关联或排除，自动 upsert 不覆盖。
- `research_commentary`：由 Dashboard 维护的政策点评；ingest 只读取是否存在，用于保护已有点评的政策卡片不被自动并入其他卡片。本仓库保留同结构的 `CREATE TABLE IF NOT EXISTS` migration，保证独立本地环境具备完整共享 D1 schema。
- 政策资讯正文保存于 `policy_news`，用于卡片证据和后续点评；研报正文仍不写 D1。
- 自动识别出近期多个卡片属于同一政策包时，保留覆盖面最完整的规范卡片，迁移其他卡片的 `policy_news` 和 AI 研报关系后删除空碎片卡片。含人工研报关系或研究点评的卡片受保护，不作为自动合并来源。

## Migration

- 所有 D1 结构变化新增 migration，不改写历史文件。
- 运行 `pnpm db:migrate:local` 后执行全部测试。
- 远端使用 `pnpm db:migrate:remote`，只在明确的 schema 交付任务中执行。
- `dashboard` 读取同一生产 D1 的文章与关键词。字段或约束变化必须同步检查其本地镜像 migration、同步脚本和热点证据查询。

## R2 与 AI Search

共享对象命名、元数据、正文保存与索引边界只在 [研究归档协议](../../eastmoney/docs/DATABASE.md#研究归档协议) 维护；本仓库步骤见 [研报](modules/articles.md) 与 [政策](modules/policies.md)。
