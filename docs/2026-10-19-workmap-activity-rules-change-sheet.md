# 工作地图活跃规则上线变更单（Space 保持关闭）

日期：2026-10-19；状态：待 Ivy 批准执行 C1 与 P1–P3

## 一句话

只把工作地图的新显示规则上线到生产。Space 同步的代码会随同一个版本进入生产，但入口、开关和数据三层都保持关闭，生产行为与今天一致，只有工作地图的展示变了。

## 版本

- **当前生产：** revision `558c39a0c5678c6d8bc17237f2b301e41527112f`（依据 2026-10-15 变更单，P1 再核对一次）。
- **候选：** `codex/phase1c-feishu-oauth` 的合并提交 `a635d47c4ba028adfa9f39a59120193b692a3a43`。它包含 PR #2（Space Phase 0–3）和 PR #3（Space Phase 2/3 与工作地图规则）。
- 合并时共 1030 项测试通过，typecheck、build 和 `git diff --check` 均通过。

## 用户能看到的变化（仅工作地图）

1. **30 天活跃窗口。** 未结束的项目，最近 30 天内有动态才留在所属线上。
   - 动态 = 关联到该项目（含同名合并条目）的来源里最新的发生时间，包括群消息、妙记、Founder 纠正、Space 评论，以及 Space 页面更新时间。
   - 一个来源都没有的项目，按创建时间算。
2. **长期无动态。** 超过 30 天没有动态、且未结束的项目，移出所属线，放到白板上高亮的“长期无动态 N 项”分区。
   - 位置在当前工作和“已结束”之间，最久没动的排前面。
   - 每行写“名称 · N 天无动态 · 最近状态”。
   - 分区顶部提示回复确认继续、暂停还是结束。
   - 文字卡片末尾同样列出，保留编号，可以直接纠正；一有新动态就自动回到原线。
   - 三条线的根条目始终显示；子项目还活跃的，父项目也保留。
3. **已结束。** 全部保留，每项一行“名称 · MM-DD 结束 · 一句结果”，标题栏用当前配色的 accent 色块，与“长期无动态”的高亮色区分。
4. **观点。** 每条线里的观点合并成一行“观点 N 条：A · B”，最多两行，不截断观点名。文字卡片里的观点和编号不变。

## 不变的部分

- A/B/C 归类、编号与纠正入口（回复卡片、批量纠正草稿与确认），以及 Founder 纠正优先于旧基线的规则。
- 5 套工作地图配色池与 25 套详情配色池，群内首屏总览 + 完整文字 + 可编辑白板入口。
- `space_managed` 隐藏策略（例如教育视频系列）。
- 不读取非白名单群聊或私人聊天，不开启 API Key fallback，group delivery 仍为 false。

## Space 如何保持关闭（三层）

| 层 | 保证方式 | 上线后核对 |
|---|---|---|
| 入口 | `server.ts` 没有向 app 传入 `spaceSyncIngest`，因此 `/internal/space-sync/v1/ingest` 路由根本不会注册。 | 请求该路径返回 404。 |
| 开关 | `SPACE_SYNC_INGEST_ENABLED`、`SPACE_SYNC_ANALYSIS_ENABLED`、`SPACE_SYNC_WORKMAP_ENABLED` 默认都是 false。worker 没有收到 `spaceAnalysisEnabled`，不会领取任何 Space 任务。 | `bridge.env` 中这三个开关不存在或为 false；不创建 HMAC secret 文件。 |
| 数据 | 生产库没有任何页面绑定、项目↔条目绑定或 Space 来源，Space 摘要块和“Space 页面”状态行都不会出现。 | 新表行数均为 0；`batch_jobs` 中没有 `analyze_founder_stream_space_batch`。 |

**已知限制：** 工作地图里的 Space 摘要块目前由“是否存在人工绑定”决定是否显示，还没有受 `SPACE_SYNC_WORKMAP_ENABLED` 控制。本次生产不写入任何绑定，所以不受影响；Space 上线前要补上这个开关判断，列入 Space 上线变更单。

## Migration

服务启动时由 `migrateDatabase()` 自动执行，只有 5 条 `CREATE TABLE IF NOT EXISTS`，全部是新增空表：

| 新表 | 用途 |
|---|---|
| `project_space_bindings` | Space 页面 ↔ 项目登记 |
| `founder_topic_project_bindings` | 项目 ↔ 工作地图条目登记 |
| `space_sync_runs` | 每次同步的回执 |
| `space_project_digests` | 每个页面版本的摘要 |
| `space_comment_threads` | 评论线程的打开/已解决状态 |

- 没有 `ALTER`、`UPDATE`、`DELETE` 或数据回填，不触碰任何现有表和数据。
- 可以重复执行；旧版本代码遇到这 5 张多出来的表会直接忽略。
- 不运行登记工具 `register-space-mapping`，不写入任何绑定。

## C1｜预览工具（本地，TDD）

现有 `src/cli/current-founder-work-map.ts --preview` 已经以只读方式（`readonly` + `query_only`）输出完整文字卡片和 `boardView`，其中包含每个条目的 `lastActivityAt`、`dormant`、`closedAt`。为了让 Ivy 在切换前直接看图，补一个预览参数：

- `--board-png <path>`：把同一份 `boardView` 用 Grove 配色渲染成 PNG（与线上同一段白板代码）。
- 新增 `activitySummary`：每个可见条目一行，内容为名称、分区（当前 / 长期无动态 / 已结束）、最近动态日期。只含条目名称和日期，不含消息正文。
- 仍然只读，不写数据库、不调用 Codex、不发消息。先写测试再实现，完整门禁通过后合并。

## 生产步骤

### P1｜只读诊断

- 核对生产 revision、running/healthy、restart count、health/ready、active jobs、pending outbox、数据库完整性与外键、feature flags、ChatGPT 登录（合并 stdout/stderr 判断）、API Key fallback=0。
- 记录当前 canonical topic 数量，作为预览的 `--expected-canonical-topics`。
- 不改数据库、不调用 Codex、不发群消息。

### P2｜隔离候选与生产只读预览

1. 在服务器构建候选镜像（OCI revision 必须精确为 `a635d47…`），不挂载生产 SQLite，不启动 webhook、worker 或自动投递。
2. 用 SQLite 在线备份做一份生产一致性副本，记录 SHA-256，放在隔离目录。
3. 用候选镜像对副本运行只读预览：`--preview --until <当前时间> --board-png`。
   - 参数与生产“查看工作地图”一致：`since=2026-08-31T00:00:00Z`，`until`=执行时刻。
4. 门禁：
   - A/B/C 结构不变；
   - canonical 数量与 P1 一致；
   - 每个可见条目都恰好落在“当前 / 长期无动态 / 已结束”之一，没有条目丢失；
   - 已结束条目全部在；
   - PNG 小于 10MB；
   - 对比度测试通过；
   - 副本 SHA-256 前后不变，证明只读。
5. **人工确认点：** 把 Grove PNG 和 `activitySummary` 发给 Ivy，确认“长期无动态”名单。名单不合适，可以先在群里纠正相应项目，再重新预览；或者在这里停止，不切换。
6. 清理隔离副本和派生图片。

### P3｜一次生产切换（Ivy 在 P2 确认后）

- 队列空闲（active jobs=0、pending outbox=0）后停止 Bridge。
- 保留带时间戳的 SQLite 一致性备份、app checkpoint 和 rollback image，记录 SHA-256、权限和 revision。
- 切换到候选并启动，然后核对：
  - health/ready、restart count、数据库完整性、ChatGPT 登录、API Key fallback=0；
  - 现有 flags 与切换前一致，group delivery=false；
  - Space 三层关闭核对全部通过（见上表）；
  - 5 张新表存在且为空；
  - 服务器上对切换后的数据库再做一次只读预览，结构与 P2 一致。
- 不发送群消息。任一项失败立即回滚。

## 最终人工验收

P1–P3 全部通过后，请 Ivy 在群里发一次 `查看工作地图`，重点看三处：

1. 长期无动态分区的名单和提示是否合适；
2. 已结束是否全部保留，并且是一行一项；
3. 观点是否已经合并成一行。

验收后，可以挑一个长期无动态的项目，回复纠正一次，确认它下一次查询时回到原线。纠正消息会作为证据挂到该项目上，因此计为新动态。

## 回滚

- **默认路径：** 停止 Bridge，切回 rollback image 与 app checkpoint，保留当前数据库。5 张新表是空的，旧代码会直接忽略，切换后产生的群消息与纠正也不会丢。
- **数据库异常时：** 完整性检查失败或出现外键异常，才恢复 P3 前的 SQLite 备份。恢复前先导出切换后新增的事件记录，以便补录。
- 本次没有任何破坏性数据迁移，回滚不需要逆向 migration。

## 风险与边界

- **动态只按“关联到该项目的来源”计算。** 群里谈到某项目、但分析没有把那条消息挂到这个项目上，就不会算作该项目的动态。P2 预览名单就是用来发现这种情况的；发现后用回复纠正即可。
- **只看飞书和 Space。** 微信不在范围内，统一通过在飞书里回复白板来纠正。
- **Space 后续上线需要另一份变更单。** 内容包括：
  - 工作地图展示受 `SPACE_SYNC_WORKMAP_ENABLED` 控制；
  - 首次真实页面读取与 Phase 4 权限核对；
  - HMAC secret；
  - 运行登记工具写入三个项目的映射；
  - 填入 Space 账号与 Ivy/James 的对应关系；
  - 真实页面的摘要效果验证。
