# Founder Stream 生产变更单 — 提案，不执行

> 固定 20 天窗口、14 个文本来源的首个持久化动作，现由更窄的 [Founder Stream：固定 20 天／14 个文本来源持久化变更单](./founder-stream-14-source-persist-change-sheet.md) 管理。该变更单已锁定 90 天原始正文保留政策，并指出当前 retention/redaction 能力是执行前阻断项。本文件继续用于后续完整上线阶段。

状态：**本地实现门禁 PASS；生产未获批准，未执行任何步骤。**

本提案对应完整复审提交 `fe102db5e73fa42b0a1235cc24f7b1844b6d4613`；Task 13 round 2 的四项原 Important 及后续问题已关闭，本地 70 文件 / 682 测试、类型检查、构建与 diff 检查通过。**这不是生产授权**。真实 perspective/alignment semantic adapter 仍未实现；本提案不得开启 ANALYSIS / GROUP_DELIVERY。本文没有真实 source count、真实工作地图或后台权限已生效的结论。

## 1. 固定范围与时间

- 唯一群：`oc_a84d5b6ca478220d0a37964b50776edb`（Ivy 与 James 现有群）。不得扩大到其他群或私人聊天。
- 审查时刻计算并冻结：
  - `since = 2026-08-31T20:04:00.338Z`
  - `until = 2026-09-20T20:04:00.338Z`
  - 差值 `1,728,000,000 ms`，恰好 20×24 小时。
- dry-run/persist 必须使用同一对字面量。若 Ivy 希望按将来的审批日重新取最近20天，应先重新计算、改提案并审批，不能执行时偷偷滑动窗口。
- 原始来源保留期：**待 Ivy 明确填写/批准**。审计/备份保留期及永久删除要求：**待 Ivy 明确填写/批准**。未确认前禁止 persist/生产开启。
- 视频、普通音频不下载不解析；原生语音本轮不新增 ASR 授权，缺文字保留 `VOICE_TEXT_MISSING`。文件/引用只获取实际已实现且获批的范围；现有 SDK 历史适配器只识别文件引用，未实现文件正文下载，不能宣称文件语义已接通。
- Minutes 纳入规则须另批准：只允许带明确 `founderStreamEligible` 与匹配批准群的来源；不批量纳入旧未标记或其他目标的会议。检查将来新会议标记策略是否符合双方的数据分享范围。

## 2. 权限/事件核验清单（本地代码不能证明后台状态）

下列 scope 名称作为变更前核对项，须在飞书开放平台当前接口说明/后台验证并记录实际授权结果；本轮没有联网核实或开通任何权限。

| 用途 | 事件/权限核对项 | 是否必须/状态 |
|---|---|---|
| 群实时消息 | `im.message.receive_v1`；读取群全部消息的应用权限 `im:message.group_msg` | 实时捕获必需；Bot 必须在唯一批准群，应用已发布，数据范围生效；待核对 |
| 群历史与话题分页 | `im.v1.message.list` 的只读授权，核对 `im:message:readonly`（或该接口当前允许的等价权限） | 初始化必需；不能仅凭入群推断能读到入群前历史；待核对 |
| 群卡片/回执发送 | `im:message:send_as_bot`，`im.message.create` | 只有另批准发送阶段才需要；待核对 |
| 妙记自动触发与读取 | `minutes.minute.generated_v1`；`minutes:minutes.basic:read`、`minutes:minutes.transcript:export` | 保持既有 user OAuth 链；不能扩大到所有人的会议；待核对 |
| 用户授权/续期 | `auth:user.id:read`、`offline_access`，已授权用户的事件订阅与 refresh 状态 | 妙记持续入口必需；只报告有效性不打印 token |
| 聊天附件资源 | `im:resource` 等按最终真实读取接口核对 | 当前没有文件正文读取实现；不因预期需求顺带开通 |
| 群管理、多维表格写入 | 无新增调用 | 不申请 `im:chat` 管理或 Bitable 写权限，不在本变更范围 |

Ivy/James 身份必须分别由可信平台 ID 确认后写入 `founder_identities`，不猜昵称、不把 chat_id 当人。身份写入本身单独审批。

## 3. 开关阶段及硬性阻塞

| 阶段 | CAPTURE | ANALYSIS | GROUP_DELIVERY | 审批/条件 |
|---|---|---|---|---|
| 部署关闭态、备份、dry-run、persist | false | false | false | 每次具体动作单独批准 |
| 仅增量捕获 | true | false | false | 本地 handoff/gap 修复已通过；仍须单独批准范围、保留期、具体配置修改及重启 |
| 分析与本地预览（目前阻塞） | true | **false** | **false** | 先单独实现并独立审查真实 perspective/alignment adapter、真实质量验收及 Ivy 明确审批；当前不得开启 |
| 指定首张地图发送（目前阻塞） | true | **false** | **false** | 前置 adapter/身份/质量门通过后，另出新变更单与 Ivy 审批，明确 mapId/pages/source-set/群；当前不得开启 |
| 持续低干扰提醒（目前阻塞） | true | **false** | **false** | 前置门与首张发送验收后另行申请持续模式；不由本地 PASS 或一次发送推断授权 |

完整变量名：`FOUNDER_STREAM_CAPTURE_ENABLED`、`FOUNDER_STREAM_ANALYSIS_ENABLED`、`FOUNDER_STREAM_GROUP_DELIVERY_ENABLED`。当前生产语义 adapter 缺口不能靠开 flags 解决；在另行实现并审查前，不允许开启 analysis/delivery。所有 AI 执行继续走服务器本地 Codex CLI + Ivy 账号，无 API Key/fallback。

## 4. 分步审批与验证

每个编号是一件事，先汇报结果再申请下一件。

1. **只读 preflight — 待 Ivy 批准。** 仅核对独立 `/opt/feishu-codex` 中运行版本/容器用户/实际数据库路径、健康/就绪、队列/lease/outbox、磁盘、现有备份、外层 `/diag/*` 访问控制、Bot/权限/身份与 OAuth/Codex 登录有效性。不得打印 secrets/正文，不访问 Amy 产品目录。若新增脚本/安装/重启有必要，另列审批。
2. **一致性备份 — 待 Ivy 批准。** 核实实际 SQLite 路径后，用 SQLite 在线 `.backup` 生成本变更专属快照（而不是拷贝正在写入的裸文件）；权限600，校验 `PRAGMA integrity_check` 与 `foreign_key_check`，记录精确路径和大小。保存目标旧 commit/image、旧配置的受保护回滚副本；密钥只记位置。不得清理历史备份或全量 app.backup 目录。对备份副本演练恢复并核对新旧表行计数。
3. **关闭态代码部署/必要 additive migration — 待 Ivy 批准。** 在已审查准确提交 `fe102db5e73fa42b0a1235cc24f7b1844b6d4613` 上生成产物、记录 checksum/镜像；三 flags 全 false。部署、迁移、重启及会议 worker 暂停影响必须明确批准。保留原会议功能配置，不顺带更改 OAuth、Nginx 或其他产品。
4. **固定窗口 dry-run — 待 Ivy 批准。** 它是飞书只读访问，不是离线测试。已审批运行环境注入凭据，命令行不含凭据；不启动后台 consumer、不打开SQLite、不调用Codex、不发送：

   ```bash
   node dist/cli/backfill-founder-stream.js --chat-id oc_a84d5b6ca478220d0a37964b50776edb --since 2026-08-31T20:04:00.338Z --until 2026-09-20T20:04:00.338Z --dry-run
   ```

   这是实际构建出的 CLI；不要在只有dist/生产依赖的镜像中调用依赖tsx/src的开发脚本。在哪个已审批容器/checkout运行需在preflight后写清楚，不自动创建一次性资源。
5. **source/gap 预览批准 — 待 dry-run 填写。** 审阅下表；`visible_range_exhausted` 不等于全租户/所有历史完整。

   | 项目 | 实测值/审批 |
   |---|---|
   | 根页/话题页/发现话题数 | 待 dry-run |
   | requested/observed 范围 | 待 dry-run |
   | text/post/voice可读条数 | 待 dry-run；不编造分项 |
   | sender unknown/app 数与语义不可用量 | 待受保护聚合预览 |
   | 文件引用/可读文件/不可读文件 | 待 dry-run |
   | 缺口代码与数量、pagination termination | 待 dry-run |
   | Ivy 是否接受当前缺口并批准存储 | 待批准 |

6. **persist — 待 Ivy 单独批准。** 确认三 flags仍false、备份可恢复、保留期已定；以相同窗口运行同一真实 CLI，将末项替换为 `--persist`。保存受保护审计清单：父/子 batch stable keys、准确source ID集合、source-set校验、chat/window/coverage/gap关联；不写Git/MEMORY。比较dry-run/persist差异，差异不自动视为完整。
7. **真实语义 adapter 实现/独立审查与身份配置 — 各需单独批准。** 不用 fake 通过替代真实接入。全部前置门通过后，才另出含分析开关变化的新变更单，申请 Ivy 批准 Codex 订阅额度消耗及分析；本提案的 analysis/delivery 继续 false。确认 capture-only 积压安全补交，不丢也不重复。
8. **初始工作地图预览 — 待 Ivy 批准生成。** 没有preview-map CLI；使用现有 `renderFounderWorkMap` 对该批次的获批topics/evidence生成受保护本地预览。预览清单留空待实测：mapId、页数、精确itemRefs、source-set、每页内容校验、覆盖缺口。不得现在编造项目/来源/卡片。Ivy只需纠错，不强迫逐项目立项。
9. **首张/指定页发送 — 待 Ivy 批准。** 明确“这个群、这个mapId、这些页、这份source-set和内容校验”。先确认不会顺带发送其他pending alignment/feedback/work-map。只enqueue批准内容；真实回执到达才绑定message ID。一次发送不意味着批准常态提醒。
10. **持续运行 — 待 Ivy 单独批准。** 对消息归类、纠错保留、双方分歧和自然解决做真实质量抽检，再批准持续低干扰模式、保留期、观察窗口与停止标准。不自动执行Todo。

## 5. 暂停/回滚真实步骤（仍未执行）

1. 异常先停止新增投递、保留现场并报告已改内容/当前可用性/风险，等待Ivy决定。仅预先批准的生产不可用紧急回滚可直接执行。
2. 关闭顺序 delivery→analysis→capture；配置修改/共享worker重启会影响既有会议，需具体批准。待consumer停止、active lease=0后继续；不要通过删库恢复健康。
3. 代码回滚使用preflight已记录的准确旧image/commit及受保护旧配置。additive schema优先留存审计；回滚前先在备份副本验证旧代码兼容性，不运行自动破坏性down migration。
4. 若确需数据库恢复：另批准写入冻结及可能丢失的备份后事件；停止全部相关写入，备份当前现场，然后把已验证的一致性快照恢复到核对过的实际DB路径。若期间原会议链路已新增数据，禁止直接覆盖整库，先提交保留这些增量的专门恢复方案。
5. 恢复后核对integrity/foreign keys、健康/就绪、会议与Founder队列/outbox计数，并报告准确恢复点。无法从本地审查预填这些生产结果。

## 6. 精确 scoped deletion/撤销（仍未执行）

没有purge/delete CLI，也不使用宽目录删除、DROP TABLE、按群或日期整表删除。

1. **批准只读预览**：在保护的DB副本绑定 `batch_key + approved_chat + exact_source_ids`，双向验证source-set与batch payload完全相同、无重复ID；大批次逐个列出父/子batch。coverage/gap不在分析source-set，若要删除必须另列精确ID。来源metadata中的群或明确Minutes eligibility必须匹配。
2. 预览每个来源到context_evidence、topic_sources/versions/relations、perspective/observation、alignment issues、feedback、其他jobs/outbox、Phase1E candidates/records/extraction/source relations和旧会议的引用图。Ivy批准精确行清单、受影响内容、前后预期计数与专属可恢复备份，不能只批准一个群ID。
3. **冻结获批批次**：确认无processing lease；在同一参数化事务中将仅获批queued/retry批次标记failed、仅获批pending outbox标cancelled。保留原状态/失败原因在受保护审计。不要扩大到同群其他job。
4. **仅无引用来源的简化物理删除**：`BEGIN IMMEDIATE` 后重新检查审批source-set/metadata边界/引用计数未改变，先删除精确批准的未生成evidence且无任何引用source，再删除对应已冻结job；每次rows affected必须与预览一致，否则ROLLBACK。所有标识通过参数绑定，不拼接来自群消息的SQL。
5. **已有共享引用**：停止简化删除。另实现“精确引用图+保留/重建共享成果”的scoped migration，在专属副本演练恢复并独立审查后，再申请审批；不得级联删整个topic绕过共享证据。
6. 事务内foreign_key_check无异常才COMMIT；后续复查准确批准行之外均不变，报告前后计数、操作者、时间、备份位置与source-set校验。删除数据库不能撤回已送达飞书卡片，也不是清除所有备份。永久删除/平台撤回/备份到期另批。

## 最终审批状态

所有生产审批栏均为**待批准**；真实source/gap统计与initial work-map预览均为**待执行对应获批步骤后填写**。四项原 Important 已通过本地复核，但真实语义 adapter 仍是明确阻塞；另行实现、独立审查和 Ivy 批准前，analysis/delivery 保持 false。本文只构成下一轮讨论材料，不构成操作授权。
