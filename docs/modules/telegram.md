# 央行资讯通知

只处理精确包含 `经济数据&政策` 标签且标题以 `中国央行：` 开头的新增资讯；全角冒号属于匹配条件。此链路不启动 ArticleWorkflow，也不做研报特征抽取。

```text
Cron → Data 列表 → 标签/标题过滤 → telegram_delivery 查重
     → 无新增则结束
     → 一个 telegram-{scheduledTime} Workflow 处理本轮全部新增
         1. D1 存 pending 通知
         2. 读取待发通知及 Secret → 发送 → 记录 sent_at / message ID
```

- 步骤重试跳过已有 message ID；实例不能发送不属于自己的记录。
- Telegram 网络结果不确定时仍可能少量重复；不能将未发送资讯误记为成功。
- Secret 只在有待发通知时从 Secrets Store 异步读取；URL、请求体、响应头与 token 不写日志，见 [SECURITY](../SECURITY.md)。
- 去重主键和记录字段见 [DATABASE](../DATABASE.md#telegram_delivery)；本次文档整理和本地模拟测试不触发真实发送。

实现从 [index.ts](../../src/index.ts) 的 TelegramWorkflow 和 scheduled 分支进入，adapter 与测试从 [src](../../src) / [tests](../../tests) 的 telegram 模块定位。完整检查按 [DEVELOPMENT](../DEVELOPMENT.md)。
