# Ingest 测试

测试取舍遵循[项目组测试规范](../../eastmoney/docs/TESTING.md)。以下为 2026-09-16 本地离线审计；覆盖率只代表注明的执行范围。

```bash
pnpm test:coverage
```

Workers pool 使用 Istanbul，Vitest 与 `@vitest/coverage-istanbul` 固定为 4.1.10。V8 在当前 workerd pool 会触发 `StubSession` 错误，不能用其失败生成的 0% 报告。`src/**/*.ts` 纳入全部源码，输出 `coverage/` HTML、JSON summary、LCOV。

75 测试；本轮行覆盖 70.00%、分支 60.34%。文章 Schema/来源标题/完整证据与 Prompt 版本仍测试，删除特征 Prompt 的八段逐句文案锁定，政策 Prompt 保留事件归并与资金利率业务约束，移除示例和润色文案重复断言。

保留 D1 幂等、Workflow 顺序、手工政策关联优先、ETag 备份、脱敏、DATA binding 拒绝代理等业务边界。后续优先补 repository/scheduled 集成：`ingest.ts` 行 37.83%、`index.ts` 43.29%、`policy.ts` 55.47%。当前覆盖不等于定时采集、真实 AI 或线上存储验收。
