# 工作地图活跃规则上线变更单（Space 保持关闭）

日期：2026-10-19；状态：C1、P1、P2（候选 2d00845）已完成；等待 Ivy 批准 P3

## 一句话

只把工作地图的新显示规则上线到生产。Space 同步的代码会随同一个版本进入生产，但入口、开关和数据三层都保持关闭，生产行为与今天一致，只有工作地图的展示变了。

## 版本

- **当前生产：** revision `558c39a0c5678c6d8bc17237f2b301e41527112f`（依据 2026-10-15 变更单，P1 再核对一次）。
- **候选：** `codex/phase1c-feishu-oauth` 上 C1 预览工具的合并提交（合并后在 P2 记录完整 SHA）。它在 `a635d47` 之上，包含 PR #2（Space Phase 0–3）、PR #3（Space Phase 2/3 与工作地图规则）和 C1。
- 依据：`558c39a` 是候选的祖先，增量都已经过评审并合并。合并前 typecheck、build、全部测试和 `git diff --check` 均通过。

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

状态：已完成（Ivy 2026-10-19 批准）。

现有 `src/cli/current-founder-work-map.ts --preview` 已经以只读方式（`readonly` + `query_only`）输出完整文字卡片和 `boardView`，其中包含每个条目的 `lastActivityAt`、`dormant`、`closedAt`。为了让 Ivy 在切换前直接看图，新增：

- `--board-png <path>`（仅 preview 可用）：用 worker 发布白板的同一段代码，把同一份 `boardView` 固定用 Grove 配色渲染成 PNG；标题取自第一张文字卡片，与线上一致。图片 ≥10MB 直接失败；不覆盖已有文件，权限 0600；输出里附带字节数和 SHA-256。
- 输出新增 `activitySummary`：每个可见条目一行，内容为名称、类型、分区（当前 / 长期无动态 / 已结束）、最近动态日期和结束日期（UTC+8），以及三个分区的计数。只含名称和日期，不含结论、正文或 Space 摘要。
- 仍然只读，不写数据库、不调用 Codex、不发消息。
- 这条预览路径不读取 5 张新表，因此可以直接在未迁移的生产副本上运行。
- 本地验证：测试先失败后通过（共 1034 项）。用 fixture 库跑编译后的 CLI：数据库 SHA-256 前后一致，PNG 正常生成；重复运行时拒绝覆盖已有图片。

## 生产步骤

### P1｜只读诊断

- 核对生产 revision、running/healthy、restart count、health/ready、active jobs、pending outbox、数据库完整性与外键、feature flags、ChatGPT 登录（合并 stdout/stderr 判断）、API Key fallback=0。
- 记录当前 canonical topic 数量，作为预览的 `--expected-canonical-topics`。
- 不改数据库、不调用 Codex、不发群消息。

### P2｜隔离候选与生产只读预览

1. 在服务器构建候选镜像（OCI revision 必须精确等于候选版本），不挂载生产 SQLite，不启动 webhook、worker 或自动投递。
2. 用 SQLite 在线备份做一份生产一致性副本，记录 SHA-256，放在隔离目录。副本不做 migration：预览路径不读新表，这样“副本前后 SHA-256 不变”才能证明全程只读。migration 本身在 P3 由服务启动执行并核对。
3. 用候选镜像对副本运行只读预览：`--preview --until <当前时间> --board-png <隔离目录>/board.png`。
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

## 执行结果

### C1（2026-10-19）

- PR #4 已合并为 `11b765125c78830fd28e082230a460b907fec92d`，tree 与测试提交 `4a5c574` 一致。它是本次候选 revision。

### P1（UTC 2026-10-19T11:42Z，只读）

- **生产状态：**
  - 容器 `feishu-codex-bridge` running/healthy，restart 0，启动于 2026-10-15T09:02Z；
  - revision 精确为 `558c39a…`，image `sha256:83d27463…`；
  - health/ready 200。
- **Space 关闭基线：**
  - `/internal/space-sync/v1/ingest` 返回 404；
  - `bridge.env` 中没有任何 `SPACE_SYNC_*`；
  - 5 张新表都不存在；
  - Space 来源与 Space 任务均为 0。
- **开关：**
  - capture、analysis、manual query、whiteboard、daily reconciliation 与 worker 为 true；
  - group delivery 为 false；
  - Codex 摘要模式为 codex。
- **登录与 Key：** ChatGPT 登录有效；env 文件和容器中均没有 OpenAI/Codex API Key。
- **数据库：**
  - `integrity_check=ok`，外键异常 0；
  - active jobs 0，pending outbox 0；
  - canonical topic **38**，作为 P2/P3 的 `--expected-canonical-topics`。
  - 最近一次工作地图投递是 2026-10-15T09:28Z。
- **发现 1｜磁盘不足，阻塞 P2：**
  - 根盘 60G，已用 59G（99%），只剩 1.2G。构建一个候选镜像约 1.5G，加上构建层，不够用。
  - Docker 可回收的空间：build cache 3.15G，未使用镜像 7.26G。后者主要是 9 月以来的 v3–v5、诊断、candidate 和 rollback 标签。
  - 清理属于删除操作，需要 Ivy 单独批准。建议只保留当前运行的镜像和 10-15 的 rollback 镜像（`f1760204…`）。
- **发现 2｜10-17 一条群消息分析失败：**
  - 任务：`analyze_founder_stream_batch`，消息时间 2026-10-17T14:20Z，失败于 `topic_analysis / codex_execution_failed`，已重试 3 次。
  - 这条消息没有挂到任何条目，所以不计入任何项目的动态。如果它说的是一个快过 30 天的项目，P2 名单可能把这个项目误列为“长期无动态”。
  - 10-15 之后的其他 14 个分析任务全部成功。
  - 补救可以用现有 `recover-founder-job-failures` 重新排队，但会调用 Codex 并写库，需要另行批准；也可以等 P2 名单出来后再看是否需要纠正。

### 磁盘清理（Ivy 2026-10-19 批准）

- 执行了 `docker builder prune -af`（清掉 8.126GB 构建缓存），并删除 25 个 `aijia/feishu-codex-bridge` 旧标签。这些标签指向的镜像都在 10-14 及以前构建；`rollback-pre-content-integrity-20261015…` 虽然名字带 10-15，但指向的是 10-14 构建的 `f9e2bb54`，所以也删了。
- 保留的镜像：当前运行的 `local`（`83d27463`）和 10-15 回滚镜像 `f1760204`（两个标签）。其他项目的镜像一律没动。删除时没有用 `-f`，被容器占用的镜像本来就删不掉。
- 根盘从 99%（剩 1.2G）降到 79%（剩 13G）。Bridge 全程 healthy，restart 0。

### P2（UTC 2026-10-19T12:18Z）

- **候选上传：** scp 中途断线，残留的半截文件已删除。改为只打包构建所需的文件（`Dockerfile`、lockfile、tsconfig、`src`），用 xz 压缩、ssh 流式上传，SHA-256 `8203a25b17fc1e92c426c933056eb4d8cf4a3bee249d35b2f74c88319bc910ca`，服务器端校验一致。
- **候选镜像：** 在独立目录 `/opt/feishu-codex/candidates/11b7651` 构建，镜像 `aijia/feishu-codex-bridge:candidate-11b7651`，ID `sha256:1ee369d174bf0add3a1f53cd3260250164f5a2fe159b1b72a5bf772a1666401b`，OCI revision 精确为 `11b765125c78830fd28e082230a460b907fec92d`。
- **一致性副本：**
  - 一次性容器以只读方式挂载生产 data 目录，用 SQLite backup API 生成副本。
  - 副本 `integrity_check=ok`，外键异常 0，SHA-256 `5b55343b8542501053d01cd23f6f425656cf027138932047719af97d02e34197`。
- **只读预览：**
  - 副本以只读方式挂载，容器设置 `--network none`、只读根文件系统，不传任何 secret，`until=2026-10-19T12:18:54Z`。
  - 候选版本和当前生产版本在同一副本上各跑了一次。
- **门禁（全部通过）：**
  - 副本 SHA-256 前后一致；
  - canonical 38；
  - 两个版本的文字卡片都是 2 页；
  - 两个版本的可见条目完全相同，都是 18 个，没有丢失；
  - A/B/C 三个根条目都在；
  - 每个条目恰好属于一个分区：当前 12、长期无动态 1、已结束 5，已结束的全部保留；
  - Grove PNG 130,646B，SHA-256 `8e2f75fd465737d540db768eea64b8ee944bf8bec380db0d4999a0b6ad655de8`，中文渲染正常；
  - 对比度沿用候选测试集里 5 套工作地图配色的门禁。
- `Fontconfig error: Cannot load default config file` 在当前生产镜像和日志里同样存在：两份镜像的 `/etc/fonts` 结构完全一样，属于既有提示，不影响渲染。
- **名单：**
  - 长期无动态只有 `AiJia AI Native 官网`（09-13 之后无动态，已 35 天）。
  - `AI 选房经验与知识库` 和 `企业微信接入` 的最近动态都是 10-14：当天 Ivy 的批量纠正把纠正证据挂到了这两个条目上，按规则算作动态，所以它们仍留在当前工作里，要到约 11-13 才会自动转入长期无动态。这与 Ivy 原本“把它们移出白板”的预期不一致，需要 Ivy 决定。
- 隔离副本和派生文件已删除；候选镜像保留给 P3。生产 revision 仍为 `558c39a`，healthy，restart 0。全程没有调用 Codex，没有写生产，也没有发群消息。

### 名单决定与暂停规则（2026-10-19）

- **Ivy 的决定：**
  - `AiJia AI Native 官网`：仍在进行，接受“长期无动态”的提示；
  - `AI 选房经验与知识库`：等 Jimmy 反馈，放进提醒区，但仍然需要；
  - `企业微信接入`：结束。
- **Ivy 的第一次群内纠正没有生效。**
  - 原因：回复里没有 `#编号`，路由只回了一句“请说明条目编号”；另外批量纠正只认 `close`，不认“结束”。
  - 即使写了编号也会失败：10-15 卡片上记录的版本已经过期（这两个条目在 10-16 被分析追加了版本），应用纠正时会因版本冲突被当成过期反馈拒绝。所以纠正必须基于一张新发的工作地图卡片。
  - 纠正走规则解析，不调用 Codex。
- **新增规则（PR #5，合并提交 `2d00845e9376e342e7853c36e5593dac66ba4ce1`，即新候选）：**
  - 暂停的条目立即进入提醒区，不再等 30 天；如果还有活跃的子项目，就留在原线；改回推进中就回到原线。
  - 提醒区更名为“暂停 / 长期无动态 N 项”，暂停行写作“名称 · 暂停 · 卡点”。
  - 测试先失败后通过（共 1036 项）。

### P2 重做（候选 `2d00845`，UTC 2026-10-19T12:50Z）

- **候选镜像：** `aijia/feishu-codex-bridge:candidate-2d00845`，ID `sha256:8508d7976be1dedf196fa89a3c181971ec4a9dc271380407676fc5fecce15a6f`，OCI revision 精确匹配。上传包 SHA-256 `58d73b62196e296472a3a67f1719015a9b0bb26239e417d56877225e665b6d11`，两端一致。
- **副本：** SHA-256 `d514fc631514fbabec6e659331c2b02ee177b92f8cccc51edfb0626442a93d97`，前后一致。
- **门禁（全部通过）：**
  - canonical 38；文字卡片 2 页；
  - 新旧版本的可见条目完全一致，都是 18 个；
  - A/B/C 三个根条目都在；
  - 分区：当前 11、提醒区 2（官网 35 天无动态、企业微信暂停）、已结束 5；
  - Grove PNG 133,133B，SHA-256 `dda0ae4b8ad6f0e82984d1ebb1449988688b932f250a1302f377407ed4c4ee3f`。
- 隔离副本已删除；`candidate-11b7651` 已作废，改由 `candidate-2d00845` 用于 P3。生产仍为 `558c39a`，healthy，restart 0。
- **生产 Codex 分析连续失败：** 2026-10-17 和 2026-10-19 12:26 的两次实时群消息分析都以 `topic_analysis / codex_execution_failed` 失败。纠正和工作地图查询都不依赖 Codex，但新群消息无法自动归入条目。这个问题需要单独做只读诊断，不在本变更范围内。
