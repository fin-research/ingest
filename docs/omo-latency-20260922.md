# OMO 延迟核验（2026-09-22）

通过 Cloudflare 实例 API 和 Messenger D1 只读查询核验；未触发真实消息。以下为优化前证据，时间均为北京时间。渠道 accepted 表示服务商接收，不能证明用户终端送达。

## 公告筛选

9 月 22 日 09:20:20 公告 `2026092200010951565` 为“中国央行今日开展350亿元7天逆回购操作”，精确包含“经济数据&政策”，但 `important=false`。旧 OMO 请求和本地复核均要求 true，导致公告存在却持续重试。本次只删除 OMO 的重要性条件；日期、标签、标题、清洗、金额校验及两步 15 秒重试保持原样。

## 9 月 21 日成功样本

| 阶段 | 相对 Workflow 开始 |
| --- | ---: |
| queued 09:20:48 → started 09:20:52.891 | 排队约 4 秒 |
| 第一步完成（3 次失败，第四次成功） | 约 56 秒 |
| 第二步完成 | 约 58 秒 |
| completed 平台事件 | 58.6 秒 |
| notification 展开完成 | 86.7 秒 |
| email accepted | 99.2 秒 |
| Telegram accepted | 109.1 秒 |
| Web Push accepted | 118.3 秒 |

第一步约含 45 秒重试等待。第二步约 1 秒，不是主要瓶颈。Cron 计划时点到实际开始另有约 53 秒，不能算作公告 API 执行耗时；当前分支已有启动与尝试日志，后续据此区分平台调度和接口耗时。

## 最近 5 条 OMO 终态事件

共 13 条渠道消息，均一次尝试 accepted。5 条 email、5 条 Telegram、3 条 Web Push。

| 平均耗时 | email | Telegram | Web Push |
| --- | ---: | ---: | ---: |
| 平台事件 → inbox | 6.9 秒 | 6.9 秒 | 7.7 秒 |
| inbox → notification | 1.6 秒 | 1.6 秒 | 1.7 秒 |
| notification → message 创建 | 20.8 秒 | 21.3 秒 | 20.4 秒 |
| message 创建 → attempt 开始 | 6.7 秒 | 14.2 秒 | 24.5 秒 |
| attempt 执行（含资格检查） | 7.8 秒 | 10.7 秒 | 9.6 秒 |
| 平台事件 → accepted | 43.8 秒 | 54.7 秒 | 64.0 秒 |

旧配置两条队列最多等 5 秒，delivery batch 内全部串行；notification 与渠道消息共用队列。串行与单消费者造成队头阻塞，渠道启动逐级推迟。notification 的约 21 秒尚无法用旧数据进一步拆分为排队和资格查询；不可全部归因于 D1 或渠道网络。

Messenger 本次将批次等待降至 1 秒，同批不同渠道及 notification 并行，同渠道保持顺序；保留原子认领、发送前资格检查、重试与不确定状态规则。增加安全分阶段日志。未修改 Cron、Workflow 重试间隔、公告清洗及消息内容。

## 历史步骤

9 月 22 日相同实例 `omo-2026-09-22` 在 09:26:20 产生 errored 事件，随后当前实例 queued 09:26:53、started 09:26:55、terminated 09:28:12。现存 API 保留当前第一步 5 次失败和 termination，第二步没有执行。时间线与重启后终止相符，但不能确定操作人或操作入口。

普通失败不会自动清除步骤；[Restart 会清除中间状态](https://developers.cloudflare.com/workflows/build/trigger-workflows/#restart-a-workflow)。当前版本成功和失败保留均为 3 天，9 月 18 日实例已不在列表，Messenger 历史仍在。已退役的 `open-market`、`article-cleanup` 命名空间也已删除。需要保留排障证据时，先用 instances describe 导出，重跑使用新的实例 ID；重跑会产生新的终态通知。

## 验收边界

本次用离线回归检查筛选、清洗、幂等与并发。部署核验不主动重跑 OMO，以免重复播报。优化后的真实端到端耗时需在后续自然运行中用相同时间口径测量，不以模拟结果宣称生产提速。
