# 研报采集与 ArticleWorkflow

源列表精确匹配 `市场解读`，每次 `pageSize=100`。Data 的顶层 array 与 `fields` 消费见 [调度架构](../ARCHITECTURE.md)，共享研报表和归档协议见 [项目组数据库](../../../eastmoney/docs/DATABASE.md#共享-d1)。

另读取 DATA `/wechat-articles?onlySubscription=true&pageSize=100&fields=sentimentId,title,accountName,time,url`，只采集生产 DM 账户已关注、上海日期自2026-10-01起的公众号文章。两列表独立失败隔离，同轮重复优先保留 news 路径。订阅每轮从当前100条中筛选2026-10-01以来内容，沿用工作日08–18点调度；休市积压在下一次交易日扫描补采。尚无已验证的翻页游标，不保证超过100条积压的历史覆盖。

每轮批量查询已有 ID 与相同标题、上海自然日。标题仅去除首尾空白，保留内部文字及标点；SQL与JavaScript采用相同空白集合。写入使用同条 `INSERT … SELECT … WHERE NOT EXISTS` 原子检查，防止两来源或并发轮询重复。历史文章与人工关系不迁移、不删除；已存在文章不因普通轮询更新。实例 ID 使用稳定 ASCII `article-{articleId}`，不能使用标题。

去重后直接启动Workflow，元数据批次最多100条、序列化最多900KiB，Cron不写D1、不预抓正文，不做实例对账或自动恢复。实例已存在时保持原状态；创建请求失败由下一轮普通列表扫描再尝试，未创建的文章没有D1预占记录。

Workflow第一步存D1元数据：相同ID允许步骤重试继续，不同ID重复标题和日期则返回`duplicate`并结束，避免并发重复处理。元数据已保存后，空正文或最终失败仍保留记录，由后续列表查重跳过；Workflow只有步骤内有限重试，耗尽后按需人工处理。

DM只保留可提取文字，不包含图片/图表；图片型PPT可能仅有提示文字，本链路不执行OCR。

## ArticleWorkflow

```text
D1 article metadata (atomic title/date deduplication)
 → DM detail
 → optional WeChat download and cleanup
 → AI feature extraction
 → D1 article + keyword
 → AI match against policies from the previous 14 days
 → remove legacy metadata, images and link destinations; prepare Chinese punctuation spacing
 → R2 Markdown + search metadata
 → Workflow archived

AI Search research independently indexes archived R2 documents
```

订阅分支在Workflow内获取DM正文，直接使用列表长URL，跳过公众号网络抓取；随后复用共同AI/特征/政策关联/R2步骤。缺省source的旧Workflow参数继续走上述news链路。此前已创建实例的额外正文快照参数不再作为必需条件。

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
- [ingest.ts](../../src/ingest.ts)：列表查重、直接启动Workflow和Workflow元数据存储。
- [index.ts](../../src/index.ts)：ArticleWorkflow 步骤；[wechat.ts](../../src/wechat.ts)：公众号下载和清洗。
- [feature-extraction.ts](../../src/feature-extraction.ts)：Prompt / Zod 特征及关键词覆盖。
- [tests](../../tests)：按 article、ingest、feature-extraction、wechat 与 Workflow 相关测试选择；默认完整检查见 [DEVELOPMENT](../DEVELOPMENT.md)。
