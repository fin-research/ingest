# Ingest 测试

测试取舍遵循[项目组测试规范](../../eastmoney/docs/TESTING.md)。`pnpm test:coverage` 使用 Workers pool 与 Istanbul；当前 workerd pool 的 V8 coverage 会触发 `StubSession` 错误，不能把失败生成的 0% 当作覆盖率。`src/**/*.ts` 纳入分母，结果写入忽略的 `coverage/`。

保留 D1 幂等、Workflow 顺序和失败恢复、人工政策关联优先、归档备份、脱敏及 DATA binding 边界的行为测试。覆盖率不等于定时采集、真实 AI、线上投递或 R2 索引验收。
