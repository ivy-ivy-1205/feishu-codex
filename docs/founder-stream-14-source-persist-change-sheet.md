# Founder Stream：固定 20 天／14 个文本来源持久化变更单

状态：**已提交供 Ivy 审批；尚未授权执行。**

retention patch 的独立工具镜像、关闭态三列迁移、备份和回滚步骤由 [Founder Stream Retention Patch 精确部署变更单](./founder-stream-retention-deployment-change-sheet.md) 管理；完成该部署验收前，本文件的持久化动作保持 HOLD。

这张变更单只解决一件事：把已经通过只读 Dry-run 验证的 14 个群聊文本来源写入生产 SQLite，作为首张工作地图的可追溯底座。它不生成工作地图、不调用 Codex、不发送群消息、不开启持续捕获。

## 1. 冻结范围

| 项目 | 固定值 |
|---|---|
| 飞书应用 | 生产 `Codex` 应用（App ID `cli_aad1fef1c7b81bda`；计划展示名 `AiJia Context`） |
| 唯一群 | `oc_a84d5b6ca478220d0a37964b50776edb` |
| 起点 | `2026-08-31T20:04:00.338Z` |
| 终点 | `2026-09-20T20:04:00.338Z` |
| 已验证读取 | 34 条可见消息，14 个可捕获文本来源 |
| 覆盖状态 | `partial` |
| 已知缺口 | 文件正文不可读 17、跳过媒体 1、跳过图片 1、已删除消息 2 |
| 原始正文保留 | 自实际持久化时刻起 90 天 |

缺口类别可能落在同一条消息上，因此不能把 `14/34` 宣称为严格覆盖率。首张地图必须继续显示 `partial` 和文件缺口。

## 2. 本次会写入什么

首次成功执行的预期变化如下：

| 数据 | 预期新增 | 用途 |
|---|---:|---|
| `context_sources` / `group_message` | 14 | 原始群聊文本来源 |
| `context_sources` / `feishu_sync_coverage` | 1 | 本次读取覆盖报告 |
| `context_sources` / `feishu_sync_gap` | 21 | 17 文件 + 1 媒体 + 1 图片 + 2 删除消息的缺口审计 |
| `batch_jobs` / `analyze_founder_stream_batch` | 1，状态 `queued` | 锁定这 14 个 source ID，留待以后单独批准分析 |
| `outbox` | 0 | 本次禁止发送任何飞书消息 |

因此本次预计新增 `context_sources` 共 **36 行**，但 CLI 输出中的 `sourcesCreated` 只统计 14 个群消息来源，预期为 `14`；`jobsEnqueued` 预期为 `1`。

这 1 个分析 job 必须保持静止。现有生产 worker 只消费既有会议 job；本次不部署 Founder Stream worker，也不打开以下三个开关：

- `FOUNDER_STREAM_CAPTURE_ENABLED=false`
- `FOUNDER_STREAM_ANALYSIS_ENABLED=false`
- `FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false`

## 3. 90 天保留策略与当前阻断项

政策已经确定：

- 14 个 `group_message.content_text` 原始正文保留 90 天。
- 来源 ID、时间范围、覆盖报告、缺口报告、纠正审计可继续保留。
- 不自动删除；到期前先生成精确预览，再由 Ivy 单独批准清理。
- 日志、Git、`MEMORY.md` 和变更报告不得复制原始正文。

**当前数据模型尚不能安全兑现“删除正文但保留来源 ID”。** `context_sources.content_text` 为 `NOT NULL`，来源哈希和后续证据引用也依赖原始记录；现有删除流程只能删除完全无引用的整个 source，不能把已经被工作地图引用的来源变成可审计的脱敏占位记录。

因此本变更单当前仍是 **执行 HOLD**。最小 retention patch 已在本地实现并通过 review；真正持久化前还必须把该 patch 纳入获批部署并完成生产迁移验证：

1. 为来源记录增加明确的正文到期时间或等价 retention 元数据。
2. 增加按精确 source ID 将正文替换为不可逆脱敏占位、同时保留来源 ID/时间/locator/审计关系的事务操作。
3. 重算或另存“原始内容已销毁”状态，不能让旧 `content_hash` 冒充正文仍存在。
4. 对已有 evidence/topic/job 引用做回归测试，确保脱敏不级联删除工作地图与纠正审计。
5. 清理预览必须同时覆盖 live DB 以及在这 90 天内形成且包含正文的备份；任何实际清理仍需 Ivy 单独批准。

本地实现还提供 `context-source:retention` 运维入口：`--preview` 与 `--execute` 互斥，必须传入唯一、非空的精确 source ID 集合和 `--as-of` 时间。preview 只输出 ID、来源类型和到期时间，不输出正文；execute 以单事务替换 source 正文及其 evidence excerpt、保留所有 ID/关系、启用 SQLite `secure_delete`，并在存在 queued/retry/processing job 或 processing extraction run 时拒绝执行。它不会自动清理备份。

实际持久化完成后，记录精确 `persisted_at` 和 `raw_text_due_at = persisted_at + 90 days`。建议在第 75 天生成只读清理预览；第 90 天不自动执行。

## 4. 精确执行顺序（每一步单独审批）

### P1 — 只读 Preflight

只核对，不修改：

- 当前 Bridge 镜像、容器、compose 路径和数据库真实路径。
- 三个 Founder Stream 开关均为 false。
- `batch_jobs`、processing lease、outbox 和数据库完整性现状。
- `/opt/feishu-codex/data/bridge.sqlite` 的属主、权限、大小和可用磁盘。
- `f38e0c2` 一次性镜像 ID 仍为已验证的 `sha256:53c576dbf0bf1c9480736d899c46ab7fb1710c5c06c0d584fb0373aed2432424`。
- retention patch 尚未部署时，保持 HOLD，不进入 P2。

停止条件：路径、镜像、开关、数据库或队列状态与变更单不一致。

### P2 — 短维护窗与一致性备份

原因：当前 persist 流程不是全流程单事务；为了避免失败时只写入一部分，需要冻结生产写入并保留可恢复点。

1. 停止 `feishu-codex-bridge`，形成短暂 webhook/会议处理暂停。
2. 确认无 active lease。
3. 使用 SQLite 在线备份能力生成本变更专属快照，权限 `600`。
4. 对快照执行 `integrity_check` 和 `foreign_key_check`。
5. 记录原生产镜像与配置位置；不复制或打印 secret。

停止条件：无法形成一致备份、完整性检查异常、仍有 active lease。发生时立即用原配置重启 Bridge，不运行持久化。

### P3 — 写入前重复同窗 Dry-run

使用保留的 `aijia/feishu-codex-dry-run:f38e0c2`、同一群和同一字面时间窗，再读一次飞书，但不挂载数据库。

硬门必须仍为：

- `messagesRead=34`
- `sourcesCaptured=14`
- `sourcesCreated=0`
- `jobsEnqueued=0`
- `filesRead=0`
- `filesUnreadable=17`
- `mediaSkipped=1`
- 缺口总计仍为 21
- 无 API、HTTP 或飞书错误码

任何数字变化都停止，不以“差不多”继续写入；先提交差异供 Ivy review。

### P4 — 一次性 Persist

运行约束：

- 只把 `/opt/feishu-codex/data` 挂载为可写。
- 通过既有 root-only env 文件获取飞书凭据；命令行和日志不打印值。
- 不挂载 Codex home，不调用 Codex。
- 三个 Founder Stream 开关显式为 false。
- 只运行一次固定窗口 CLI 的 `--persist` 模式，容器结束后删除。

预期结果：

- `sourcesCaptured=14`
- `sourcesCreated=14`
- `jobsEnqueued=1`
- 无消息投递

如果命令异常退出或数字不符，Bridge 保持停止；不得直接重跑，进入 P6 回滚判断。

### P5 — 写后验证并恢复原 Bridge

在恢复服务前只读验证：

1. 精确 14 个 `group_message` 来源全部属于批准群和冻结窗口，无重复 logical key/version。
2. 本次 capture 对应 1 个 coverage 和 21 个 gap 审计来源。
3. 恰好 1 个 `analyze_founder_stream_batch` job，payload 中 source-set 恰好等于上述 14 个来源 ID，状态仍为 `queued`。
4. 本次没有新增 outbox、summary、topic、perspective、alignment 或群消息投递记录。
5. `integrity_check` 和 `foreign_key_check` 通过。

验证通过后，仅用原生产镜像和原配置重启 `feishu-codex-bridge`；不部署 Founder Stream 新代码。随后验证 `/health`、`/ready` 和既有妙记链路，确认 Founder job 仍未被消费。

### P6 — 失败回滚

- 因为 P2 已冻结写入，若 P4/P5 失败，可在 Bridge 仍停止时，用本次一致性快照恢复数据库。
- 恢复前保留失败现场副本；恢复后再次执行完整性检查。
- 只启动原 Bridge 镜像/配置，不修改 Nginx、飞书后台、Secrets 或其他产品。
- 若维护窗内意外产生了无法重放的新会议事件，则禁止整库覆盖，改为提交精确行级恢复方案。

## 5. 明确不在本次范围

- 不启用持续群消息捕获。
- 不实现或调用真实 Ivy/James 观点与分歧语义适配器。
- 不调用服务器 Codex CLI，不消耗 Codex 订阅额度。
- 不生成或发送首张工作地图。
- 不读其他群、私聊或新的妙记。
- 不处理 17 个文件正文，不下载视频、音频或图片。
- 不修改 Bot 展示名；`AiJia Context` 的后台改名另行操作。
- 不自动执行 90 天清理。

## 6. 审批门

| 门 | 当前状态 |
|---|---|
| 范围与 90 天政策 | Ivy 已接受 |
| 本精确变更单 review | 待 Ivy review |
| retention patch 实现与本地 review | 已完成；72 个测试文件 / 691 个测试、typecheck、build、diff check 全部通过 |
| retention patch 获批部署与生产迁移验证 | **阻断，尚未执行** |
| P1 只读 Preflight | 待单独批准 |
| P2 停服与一致性备份 | 待单独批准 |
| P3 重复 Dry-run | 待单独批准 |
| P4 持久化 | 待单独批准 |
| P5 重启与验证 | 待单独批准 |

批准本文件只代表接受方案，不代表授权执行任何服务器操作。
