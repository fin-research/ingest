# 安全边界

## Secret 与配置

- `CF_AIG_TOKEN` 只通过 Worker Secret 注入。
- `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_USER_ID` 使用 Cloudflare Secrets Store binding，运行时通过异步 `.get()` 读取；只在出现待发送资讯时读取。
- `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID` 与 `ARTICLE_API_BASE_URL` 是非敏感配置，保存在 `wrangler.jsonc`。
- `.env`、`.dev.vars` 和实际 token 不得提交。
- Telegram API URL、请求体、响应头和 Secret 值不得写入日志；日志只记录公开文章 ID、计数和脱敏错误。

## 外部数据

- `ARTICLE_API_BASE_URL` 必须使用 HTTPS。
- 该地址保留生产 `/data` 契约；Cron 和 Workflow 通过 `DATA` binding 的 `InternalData` 入口读取列表与详情，不依赖浏览器 Cookie 或公网匿名访问。公众号和 AI 请求保持各自既有通道。
- 列表、详情、公众号 HTML 和 AI 响应都必须限长读取并运行时校验。
- 不把未经校验的 JSON 或 HTML 直接断言成业务类型。
- 公众号 Markdown 清洗移除图片 URL 和链接 URL，保留链接锚文本，并按既有规则截断风险披露后文。

## AI

- 所有生成式请求经 `src/ai-gateway.ts`；业务模块不得自行拼 Gateway 请求。
- Provider、重试、Prompt Cache、reasoning 参数、限长读取和日志规则只在 [共享 AI](../../eastmoney/docs/AI.md) 维护。
- Zod Schema 是结构化输出唯一来源；特征与政策 Prompt 归各业务模块维护，不重复手写返回结构。

## Cloudflare 资源

- D1、R2 与 Workflow 使用 binding，避免在 Worker 中使用管理 API token。AI Search 独立读取 R2，Worker 不持有其 binding 或管理凭证。
- AI Search 的 `queued` / `running` 状态不得当作成功；最终复核后才能报告修复完成。
- 正文备份和验收记录只能保存在 Git 忽略的 `var/` 目录，不得提交。

## 日志

- 结构化日志只包含事件名、数量、文章 ID、公开错误和 Workflow 状态。
- 不记录 Secret、管理 token、完整正文、原始公众号 HTML 或外部响应头中的敏感信息。
