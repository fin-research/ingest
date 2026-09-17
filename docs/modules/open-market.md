# 公开市场操作播报

Cron 在周一至周五北京时间 09:20 启动 `omo` / `OmoWorkflow`，日实例为 `omo-YYYY-MM-DD`。旧 `open-market` 命名空间保留历史，不再由 Cron 创建实例。

- 循环位于 `step.do` 外，每次进入独立 `poll-N` step；查询结果、错误和下次时间持久化后，由 `wait-N` sleepUntil 等待。恢复时复用已完成查询的 checkpoint。
- 当日 `[09:20,09:25)` 内每 10 秒查询。列表与详情经 DATA / InternalData，复核上海日期、经济数据&政策标签、重要性、标题前缀中国央行及净投放/净回笼正文。
- 单次请求最长 10 秒且不能超过 09:25；超时终止请求，不接受截止后响应。查询失败在剩余窗口重试，错误保留安全 HTTP 状态或错误类型。
- 清洗去除投标量/中标量金额分句和 DM数据显示，保留操作金额、期限、利率、到期量及净投放/净回笼。
- 成功直接返回日期、正文、文章 ID、尝试和错误次数；9:25 未找到则在 retries.limit=0 的 deadline-failure step 抛 Error，包含截止时间、查询/失败次数及最后错误，平台状态为 errored。
- 不再有 notify step 或 Messenger 调用。成功和失败均由平台事件队列送 Messenger，统一 email＋Telegram。

测试覆盖筛选、清洗、独立轮询 checkpoint、截止边界、悬挂请求、Cron 幂等及真实 Workers runtime 失败状态。
