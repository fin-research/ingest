# 研报采集与 ArticleWorkflow

源列表精确匹配 `市场解读`，每次 `pageSize=100`。Data 的顶层 array 与 `fields` 消费见 [调度架构](../ARCHITECTURE.md)，共享研报表和归档协议见 [项目组数据库](../../../eastmoney/docs/DATABASE.md#共享-d1)。

另读取 DATA `/wechat-articles?onlySubscription=true&pageSize=100&fields=sentimentId,title,accountName,time,url`，只采集生产 DM 账户已关注的公众号。两列表独立失败隔离，同轮重复优先保留 news 路径。订阅每轮回看当前100条，沿用工作日08–18点调度；休市积压在下一次交易日扫描补采。尚无已验证的翻页游标，不保证超过100条积压的历史覆盖。

每轮批量查询已有 ID 与相同标题、上海自然日。标题仅去除首尾空白，保留内部文字及标点；SQL与JavaScript采用相同空白集合。写入使用同条 `INSERT … SELECT … WHERE NOT EXISTS` 原子检查，防止两来源或并发轮询重复。历史文章与人工关系不迁移、不删除；已存在文章不因普通轮询更新。实例 ID 使用稳定 ASCII `article-{articleId}`，不能使用标题。

订阅候选按最多4路并发读取DM详情正文，非空正文快照随Workflow参数传入；完整JSON按UTF-8计量须小于1MiB，空正文、请求失败、超限不写入D1、不截断，后续轮询可以重试。DM只保留可提取文字，不包含图片/图表；图片型PPT可能仅有提示文字，本链路不执行OCR。

每批最多100条，先写入再启动；后批失败不回滚前批。启动异常按实例ID对账，保留全部本批新增行，后续轮询恢复；避免另一个Cron已恢复实例时误删文章。每轮先独立扫描 `prompt_version IS NULL` 记录，对运行中或已完成实例保留，失败实例使用原参数重启，明确不存在时重建。首次订阅插入已保存列表长URL、news插入的link为空，可据此恢复未启动记录；已有实例不改来源。人工终止实例不自动重启，记录异常。恢复不依赖当前100条列表窗口，也不受列表接口失败阻断。

## ArticleWorkflow

```text
DM detail
 → optional WeChat download and cleanup
 → AI feature extraction
 → D1 article + keyword
 → AI match against policies from the previous 14 days
 → remove legacy metadata, images and link destinations; prepare Chinese punctuation spacing
 → R2 Markdown + search metadata
 → Workflow archived

AI Search research independently indexes archived R2 documents
```

订阅分支为：预抓DM正文快照 → `prepare subscribed article from DM` → 共同AI/特征/政策关联/R2步骤；直接使用列表长URL，跳过公众号网络抓取。缺省source的旧Workflow参数继续走上述news链路。

- DM 详情步骤幂等更新原文 link。
- 公众号下载是独立可重试步骤；失败回退 DM 已清洗正文。
- AI 特征抽取使用统一 adapter 和 Zod Schema；传输/重试遵循 [共享 AI](../../../eastmoney/docs/AI.md)。Adapter 失败再交给 Workflow 步骤重试，残缺结果不保存。
- 特征与关键词在一次 D1 `batch()` 中覆盖。
- ArticleWorkflow 返回 `status: archived` / `indexing: r2-source`；索引完成必须独立检查 `completed`。
- R2 原始中文 Markdown 仍可能触发 `file_content_empty`，因此复用 `prepareAiSearchMarkdown` 在唯一一次存储前处理标点，AI 特征抽取仍使用原文。
- `prepareAiSearchMarkdown` 是研报和政策共用的归档入口：去除正文前的旧 `Source / Published / URL` 等英文元数据头部；移除内联/引用式图片、HTML 图片和链接目标，保留链接文字、标题、表格及段落。正文内的“数据来源”等研究引用保留。清洗覆盖 DM 回退和已缓存的 Workflow 正文，不依赖公众号下载是否成功。
- Markdown 使用 CommonMark 源位置处理嵌套括号、图片外层链接和引用定义；损坏公众号 URL 中的空格也须整体消费，避免留下查询参数片段。归档清洗与中文标点补空格整体幂等；历史回填不额外截断风险披露。
- 历史研报维护 Workflow `article-cleanup` 已退役；保留备份、清洗函数和回归测试，新归档继续自动清洗。历史证据见 [DEVELOPMENT](../DEVELOPMENT.md#历史研报正文清洗)。

归档对象、检索元数据和索引完成边界只按 [研究归档协议](../../../eastmoney/docs/DATABASE.md#研究归档协议) 维护；与政策的双向关联规则见 [政策模块](policies.md)。

## 实现与验证

- [article.ts](../../src/article.ts)：列表/详情契约、日期和稳定 key。
- [ingest.ts](../../src/ingest.ts)：查重、只写新增、Workflow 分发与恢复。
- [index.ts](../../src/index.ts)：ArticleWorkflow 步骤；[wechat.ts](../../src/wechat.ts)：公众号下载和清洗。
- [feature-extraction.ts](../../src/feature-extraction.ts)：Prompt / Zod 特征及关键词覆盖。
- [tests](../../tests)：按 article、ingest、feature-extraction、wechat 与 Workflow 相关测试选择；默认完整检查见 [DEVELOPMENT](../DEVELOPMENT.md)。
