# 研报采集与 ArticleWorkflow

源列表精确匹配 `市场解读`，每次 `pageSize=100`。Data 的顶层 array 与 `fields` 消费见 [调度架构](../ARCHITECTURE.md)，共享研报表和归档协议见 [项目组数据库](../../../eastmoney/docs/DATABASE.md#共享-d1)。

每轮先批量查询已有 ID，只对新增项写 D1 并启动 Workflow；已存在文章不因普通轮询更新。实例 ID 使用稳定 ASCII `article-{articleId}`，不能使用标题。启动失败删除本轮实际新增去重行，允许下轮重试。

## ArticleWorkflow

```text
DM detail
 → optional WeChat download and cleanup
 → AI feature extraction
 → D1 article + keyword
 → AI match against policies from the previous 14 days
 → prepare Chinese punctuation spacing
 → R2 Markdown + search metadata
 → Workflow archived

AI Search research independently indexes archived R2 documents
```

- DM 详情步骤幂等更新原文 link。
- 公众号下载是独立可重试步骤；失败回退 DM 已清洗正文。
- AI 特征抽取使用统一 adapter 和 Zod Schema；传输/重试遵循 [共享 AI](../../../eastmoney/docs/AI.md)。Adapter 失败再交给 Workflow 步骤重试，残缺结果不保存。
- 特征与关键词在一次 D1 `batch()` 中覆盖。
- ArticleWorkflow 返回 `status: archived` / `indexing: r2-source`；索引完成必须独立检查 `completed`。
- R2 原始中文 Markdown 仍可能触发 `file_content_empty`，因此复用 `prepareAiSearchMarkdown` 在唯一一次存储前处理标点，AI 特征抽取仍使用原文。

归档对象、检索元数据和索引完成边界只按 [研究归档协议](../../../eastmoney/docs/DATABASE.md#研究归档协议) 维护；与政策的双向关联规则见 [政策模块](policies.md)。

## 实现与验证

- [article.ts](../../src/article.ts)：列表/详情契约、日期和稳定 key。
- [ingest.ts](../../src/ingest.ts)：查重、只写新增、Workflow 启动回滚。
- [index.ts](../../src/index.ts)：ArticleWorkflow 步骤；[wechat.ts](../../src/wechat.ts)：公众号下载和清洗。
- [feature-extraction.ts](../../src/feature-extraction.ts)：Prompt / Zod 特征及关键词覆盖。
- [tests](../../tests)：按 article、ingest、feature-extraction、wechat 与 Workflow 相关测试选择；默认完整检查见 [DEVELOPMENT](../DEVELOPMENT.md)。
