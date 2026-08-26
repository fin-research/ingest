# 安全边界

## Secret 与配置

- `CF_AIG_TOKEN` 只通过 Worker Secret 注入。
- `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_USER_ID` 使用 Cloudflare Secrets Store binding，运行时通过异步 `.get()` 读取；只在出现待发送资讯时读取。
- `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID` 与 `ARTICLE_API_BASE_URL` 是非敏感配置，保存在 `wrangler.jsonc`。
- 维护脚本的 `CLOUDFLARE_API_TOKEN` 只从环境读取，不写配置、命令历史示例或日志。
- `.env`、`.dev.vars` 和实际 token 不得提交。
- Telegram API URL、请求体、响应头和 Secret 值不得写入日志；日志只记录公开文章 ID、计数和脱敏错误。

## 外部数据

- `ARTICLE_API_BASE_URL` 必须使用 HTTPS。
- 列表、详情、公众号 HTML 和 AI 响应都必须限长读取并运行时校验。
- 不把未经校验的 JSON 或 HTML 直接断言成业务类型。
- 公众号 Markdown 清洗移除图片 URL 和链接 URL，保留链接锚文本，并按既有规则截断风险披露后文。

## AI

- 所有生成式调用经过 `src/ai-gateway.ts`；业务模块不得自行拼 AI Gateway HTTP 请求。Adapter 只允许调用固定的 `custom-opencode/responses` 与 `custom-codex/responses` provider-specific URL，避免进入 Universal 适配层。
- Zod Schema 是结构化输出唯一来源；Prompt 不重复手写返回结构。
- Responses 请求显式使用 `store=true`，表示允许自定义 Provider 持久化 Response；这不开放原始推理过程。稳定抽取规则放在 `instructions`，单篇标题和正文只放在末尾 `input`，并使用版本化 `prompt_cache_key` 复用上游 Prompt Cache。
- 输入正文不截断，不设置 completion token 上限；响应达到读取上限或 Schema 不完整时必须失败并重试。
- 日志可记录文章 ID、Prompt 版本、模型、Provider 尝试顺序、任务类型、effort、`store` 回执、Prompt Cache token 计数、加密推理存在性、输出长度、HTTP 状态和 Gateway log ID，不记录 token、完整正文或完整 Provider 响应。

## Cloudflare 资源

- D1、R2、Workflow 与 AI Search 优先使用 binding，避免在 Worker 中使用管理 API token。
- 维护脚本需要外部 API 权限时，先盘点后显式 `--execute`；删除或重传必须按精确 Item key。
- 使用 `--wrangler-auth` 时，子进程主动移除 `CLOUDFLARE_API_TOKEN`，避免低权限 token 覆盖本机 OAuth。
- AI Search 的 `queued` / `running` 状态不得当作成功；最终复核后才能报告修复完成。

## 日志

- 结构化日志只包含事件名、数量、文章 ID、公开错误和 Workflow 状态。
- 不记录 Secret、管理 token、完整正文、原始公众号 HTML 或外部响应头中的敏感信息。
