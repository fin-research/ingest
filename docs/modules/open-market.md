# 公开市场操作播报

现有 Cron 在周一至周五北京时间 09:20 启动 `open-market` Workflow，实例 ID 为 `open-market-YYYY-MM-DD`。工作日沿用仓库 Cron 的周一至周五定义，不另接节假日或调休表。

```mermaid
flowchart LR
  loop[loop] -->|播报或失败结果| notify[notify]
```

- `loop`：在当日 `[09:20,09:25)` 内每 10 秒查询一次；列表经 DATA / InternalData 请求 `/news?tag=经济数据%26政策&important=true&date=YYYY-MM-DD&pageSize=100`，投影字段增加 `important`。再次核对上海日期、精确标签、重要性和标题前缀 `中国央行`，按 sentimentId 获取详情，匹配正文 `净投放` 或 `净回笼`。匹配后立即停止；单次列表/详情/正文读取整体最长 10 秒，且不能超过 09:25。延迟启动只使用剩余窗口。
- 清洗去除投标量/中标量的金额分句和 `DM数据显示`，保留操作金额、期限、利率、到期量和净投放/净回笼。正文超 Telegram 限长时按查询失败处理，不截断业务数据。
- 查询错误记入结果并在窗口内继续轮询；截止后返回 `not_found` 或 `failed`，成功返回 `found`，同时携带日期、尝试次数、错误次数和通知正文。Promise settled 结果在 step 内转成可序列化数据，新流程不使用 `try/catch`，不新增 sleep step。
- `notify`：读取 `loop` 的结果，成功推送清洗后的正文，未找到或查询异常推送失败通知。通过 MESSENGER / Messaging 提交 `source=ingest`、`channel=telegram`、`idempotencyKey=open-market/YYYY-MM-DD`；重试共用业务键。返回 `messengerId` 与 `delivery=submitted`，实际渠道投递、失败和人工重试由 Messenger 管理。

测试覆盖原文清洗、筛选契约、10 秒轮询、错误恢复、截止边界、日调度、通知 payload 和 Workers runtime 两步骤执行。没有新 D1 表或 migration。
