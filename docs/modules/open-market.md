# 公开市场操作播报

Cron 在周一至周五北京时间 09:20 创建并执行 `omo` / `OmoWorkflow`，日实例为 `omo-YYYY-MM-DD`；不提前创建实例，也不使用 `sleepUntil`。旧 `open-market` 和 `article-cleanup` 已退役并移除绑定。手动指定日期的实例仍立即执行；两个业务 step 和重试策略保持不变。`ingest_cron_started` 和 `omo_bulletin_attempt` 记录计划时间、实际时间与延迟。

Workflow 只有两个顺序 step：

1. `获取并清洗央行投放公告`：经 DATA / InternalData 获取当日“经济数据&政策”资讯，复核上海日期、标签和标题前缀“中国央行”，不按重要性筛选。正文不要求含净投放/净回笼，去除投标量、中标量金额分句，并截掉“据DM数据显示”（兼容“DM数据显示”）及以后全部文字。验证剩余投放操作及金额；无匹配正文即抛错。
2. `查询到期回笼并生成播报`：请求 `/data/omo?startDate=当日&endDate=当日`，只汇总到期回笼数据，正文投放金额减到期量生成净投放/净回笼，零净额表述为持平。金额统一亿元，兼容到期量的负号和正数表示；期限使用明确中文。API 其他投放项不替代新闻正文，也不混入总投放。空响应、跨日数据、到期记录/金额/期限缺失视为失败，不填零；无到期日须由接口提供明确零金额到期记录。

两个 step 都使用 Workflow 原生 `retries: { limit: 20, delay: "15 seconds", backoff: "constant" }`，即首次执行后最多 20 次重试；无循环 step 和 sleep step。不设 09:25 或其他运行时段截止；延迟启动、09:25 后正文发布及手动按日期运行均可正常执行。每次请求最长 10 秒，失败由平台恒定延迟重试，耗尽后失败。日期参数无效才使用 `NonRetryableError`。完成的第一步在第二步重试时直接复用。

最终继续返回日期、`status=found`、正文 `text`、文章 ID、第一步尝试/失败次数；Messenger 仍消费 `text`。Workflow 内没有通知调用，平台成功/失败事件由 Messenger 统一投递。
