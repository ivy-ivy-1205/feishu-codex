# Founder 工作地图内容治理与完整性修复变更单

日期：2026-10-14
状态：P1–P3 已完成；生产运行 revision `f6ea74c5153c20a1fd41eb7b4e20058ac8e63645`

## D4 现场结论

群内交互形式已经通过：首屏直接显示风格化总览，完整文字保留，可编辑白板为次要入口，随机配色来自 Ivy 的已选集合。本单不改变这些交互。

内容验收仍有四个缺口：

1. `企业微信接入` 虽为 paused 且属于 C 线，白板却因把 paused 与 closed 合并而落入“已结束／历史”。
2. “隐藏孤立 active topic”只过滤 `active_project`，未过滤同样未确认归属的 `project_candidate` 与 `exploring`，导致讨论片段形成“待核对／其他项目”第四栏。
3. 历史脏名称未经展示清洁；Founder 批量纠正证据被当作普通群消息，在多个项目下重复展示整段原文。
4. 处理状态按失败 job 数显示“未补偿失败”，同一来源可重复计数，也未区分分析缺口与采集失败；截图显示最后完成分析早于最新收到语料，不能证明当前地图完整覆盖最新内容。

## 本地修复范围

### L1｜内容归类

- 白板只把 `closed` 放入历史区；`paused` 继续留在所属 A/B/C 主线并显示暂停状态。
- 已启用“隐藏孤立 active”偏好时，同时隐藏未归入主线的 `active_project`、`project_candidate`、`exploring` 与 `idea`；不删除 topic、来源、版本或关系。已归入主线的 `idea` 继续显示。
- `idea` 若已归入主线，继续以“观点”展示；不把它升级为独立项目。

### L2｜展示清洁

- 仅在展示投影中移除名称开头的空白与异常标点，不改历史数据库名称。
- 已应用的 Founder 纠正消息显示为“来源：Ivy 工作地图纠正 + 时间”；保留追溯关系，但不在每个项目下重复整段纠正原文。
- 群内图片、完整文字、随机配色与可编辑白板入口的位置保持不变。

### L3｜完整性诊断与恢复入口

- 状态区分别显示：最后完成分析时间、最新已分析语料时间、未补偿分析来源数、分析异常任务数、采集失败任务数和不可读／跳过缺口数。
- 同一来源被多个失败 job 引用时只计一次；后来已成功分析的来源不再算作未补偿。
- 新增 fail-closed 恢复 CLI：preview 只输出聚合数量和 `recoveryId`；apply 必须显式传入同一 `recoveryId`，事务性重排精确失败任务。已被后续成功覆盖的任务不重排；分析任务只保留仍未覆盖的 source ID；不输出正文或来源 ID。

## 生产步骤（待一次性批准）

最终本地门禁：`pnpm test` 99 个测试文件、840 项测试全部通过；`pnpm typecheck`、`pnpm build` 与 `git diff --check` 全部通过。

### P1｜只读现场核验

- 核对当前 revision、健康状态、restart count、active jobs、pending outbox、数据库完整性和既有 feature flags。
- 使用新候选对生产数据库只读 preview，仅记录失败类型／错误阶段聚合、唯一未分析来源数、采集失败数、最新已分析语料时间和 `recoveryId`；不输出正文、消息 ID 或 source ID。

### P2｜隔离副本恢复门禁

- 使用 SQLite Backup API 建立生产数据库一致性副本；在副本上按 P1 的 `recoveryId` apply。
- 用候选 worker 处理副本中的恢复任务，关闭 webhook 入口、自动群发送、manual query、whiteboard 和 daily reconciliation；不发飞书消息。
- 要求可恢复任务全部完成；若仍有失败，记录聚合错误并停止，不改生产。随后从副本生成工作地图并断言：paused 项目归属、无第四个杂项项目栏、清洁名称、纠正来源摘要、A/B/C 层级及图片限制。

### P3｜一次生产切换

- 再次确认队列空闲，停止 Bridge；创建正式 SQLite 备份、app checkpoint 和 rollback image。
- 在停止态用精确 `recoveryId` 重排失败任务并切换候选；启动后等待恢复任务终态，核对数据库完整性、健康、restart count、ChatGPT 登录、无 API Key fallback、feature flags 不变、group delivery=false。
- 在服务器只读生成当前工作地图 PNG 和文字卡，记录尺寸、字节数、SHA-256 与结构断言；不发送群消息。
- 任一门禁失败立即恢复旧数据库、旧应用和旧镜像。自动门禁全部通过后再决定是否需要新的人工验收；不要求 Ivy 在修复过程中重复调用。

## 回滚与数据边界

- 不删除 topic、版本、来源、关系或失败任务；失败任务只在精确确认后从 `failed` 重排为 `queued`，原 stable key 保留。
- 不读取非白名单群或私人聊天，不下载视频／普通音频，不开启 OpenAI API Key fallback。
- 生产副本与派生 PNG 在验收后删除；正式关闭态备份、checkpoint 与 rollback image 保留。

## 执行记录（2026-10-15）

- P1 确认旧生产 revision `f04442e4702d4d65de7bf2212798aa5d50bac95f` 为 running/healthy、restart 0，health/ready 200，active jobs=0、pending outbox=0，SQLite `integrity_check=ok` 且无外键异常；既有 feature flags 不变，group delivery=false，无 API Key fallback。恢复 preview 为 20 个分析任务、34 个唯一未补偿来源、0 个采集任务，`recoveryId=founderjobrecovery_ef8a9881f5dd8d25afcafc4dd83b364f`。
- 首轮隔离恢复暴露两个生产数据路径缺口：较新的 Founder 批量纠正会被更早的确认基线覆盖；未归入 A/B/C 的孤立 `idea` 仍形成第四栏。提交 `be5357d` 改为较新的 Founder 纠正优先于旧基线，提交 `f6ea74c` 在隐藏孤立条目时同时覆盖 `idea`，并新增回归测试。
- P2 最终候选镜像 `aijia/feishu-codex-bridge:content-f6ea74c` 的 OCI revision 精确为 `f6ea74c5153c20a1fd41eb7b4e20058ac8e63645`。全新隔离副本的 20 个恢复任务全部完成，最终 preview 为 0；内容与图片门禁通过：`企业微信接入` 为 paused 且位于 C 线，无“待核对 / 其他项目”第四栏，名称已清洁，纠正显示为摘要且不重复原文，A/B/C 层级完整。
- P3 于 `2026-10-15T05:33:06.183487493Z` 启动新 Bridge。正式 SQLite 备份为 `/opt/feishu-codex/backups/bridge-pre-content-integrity-20261015T053026Z.sqlite`，3305472 bytes，SHA-256 `515f10a0cc900482da2e7da317ad82b693211fd4c785430f1ccce94d39917550`；app checkpoint 为 `/opt/feishu-codex/checkpoints/app-pre-content-integrity-20261015T053026Z`；rollback image 为 `aijia/feishu-codex-bridge:rollback-pre-content-integrity-20261015T053026Z`。
- 生产 20 个恢复任务全部完成；唯一保留的旧 failed 记录已被后续成功分析覆盖，恢复 preview 为 0。真实无业务数据 Codex 结构化探针返回 `{"ok":true}`。终态 revision 为 `f6ea74c5153c20a1fd41eb7b4e20058ac8e63645`，image `sha256:f1760204e0e99809435d73708b3738c2893e7dd6a6526e356a9db0609f40a40a`，running/healthy、restart 0、health/ready 200，active jobs=0、pending outbox=0，数据库完整且无外键异常，feature flags 不变、group delivery=false、API Key fallback=0。
- 生产只读最终地图为 33 个 canonical topics、19 个可见条目、2 页文字卡；固定门禁配色 `court-press` 的 PNG 为 1160×2431、151590 bytes、SHA-256 `1999e058595e987263d9ae69dc76e97d0dfb95bf02378c5f67f6bc426c83e386`，98 个节点。全部结构断言通过，未发送群消息，现有群内图片 + 完整文字 + 次要编辑入口的交互形式未改变。
- 两次切换在备份验证阶段因 WAL 模式备份缺少 sidecar、只读连接返回 `SQLITE_CANTOPEN` 而自动回滚；备份文件本身经可写连接验证均完整。最终改为停止态 SQLite Backup API 后以根用户可写连接只做 integrity/FK 验证，切换成功。失败尝试备份、隔离副本、候选上传物和候选标签已清理，仅保留正式回滚资产。
