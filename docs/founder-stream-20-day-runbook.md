# Founder Stream：20 天初始化与持续对齐运行边界

本轮交付是本地实现与 fake 验证，不授权访问飞书生产数据、SSH、生产数据库、部署、迁移、重启或发送群消息。本手册里的生产步骤全部是待审批操作，必须先向 Ivy 提交具体变更单；每次只执行获批的一件事。

## 1. 只读 Preflight（需要单独批准）

确认目标仍是 Ivy 与 James 已确认的唯一白名单群；不扩展到其他群或私聊。检查以下事实，但不输出凭据值、原文、身份 ID 或原始游标：

- 应用已发布，机器人在目标群；消息接收、历史消息读取与文件读取权限及数据范围在飞书后台实际生效。代码声明不能证明后台已开通，也不能证明机器人能看见入群前全部内容。
- Ivy/James 的 `founder_identities` 配置应各自唯一且由本人/可信平台 ID 确认；不能按昵称猜身份。身份未配置或发送者未知时，仅归纳话题，不声称已提取双方观点/达成共识。
- 代码版本、数据库版本、现有会议 worker 状态、积压、磁盘容量和备份恢复可用性。生产数据库路径/secret 位置沿用现有独立 `/opt/feishu-codex` 部署，不使用 Amy workspace。
- `/diag/founder-stream` 与既有 `/diag/context` 一样没有应用层认证；访问限制依赖外层 Nginx/网络配置。启用前只读核对外部访问控制，不能把“聚合脱敏”当作认证。不得未经批准公开此端点。
- Codex CLI 使用 Ivy 已登录的 ChatGPT/Codex 订阅；不配置 API Key、不增加 API fallback。就绪检查只能证明所启用管线的消费器/所需登录检查，不保证远程模型实际调用始终成功。

生产 secrets 只能存在既有受保护文件中；本手册不要求打印或粘贴其值。任何安装、身份写入、配置修改、备份、部署和服务重启均另行审批。

## 2. 冻结一个精确的 20 天 UTC 窗口

初始化起点不能只写“最近 20 天”。审批单必须记录实际计算得到的 `since`、`until`，并检查二者恰好相差 1,728,000,000 毫秒。

示例窗口（仅示范，不是本次生产批准）：

- `until = 2026-09-21T00:00:00.000Z`
- `since = 2026-09-01T00:00:00.000Z`
- 差值 = 20 × 24 小时。

可在本地计算新的提案时间，之后将输出的两个字面量写入审批单并冻结：

```bash
node -e 'const until=new Date(); const since=new Date(until.getTime()-20*86400000); console.log(JSON.stringify({since:since.toISOString(),until:until.toISOString(),durationMs:until-since}))'
```

dry-run 与 persist 必须复用同一对时间，不能重新计算。CLI 已支持可选 `--until`；缺省时保持旧行为（以调用时刻截止），但正式初始化应显式传入。截止后产生的新讨论由增量管线接手。

## 3. 历史 dry-run（只读飞书，不是离线模拟）

先取得 Ivy 对“指定群 + 冻结窗口 + 只读”的批准。下例引用实际存在的 CLI 参数；执行前只替换为已批准的两个时间。运行环境应通过既有安全机制注入凭据，不在命令行放密钥。

```bash
pnpm founder-stream:backfill -- --chat-id oc_a84d5b6ca478220d0a37964b50776edb --since 2026-09-01T00:00:00.000Z --until 2026-09-21T00:00:00.000Z --dry-run
```

dry-run 会访问真实飞书，但不打开/迁移 SQLite、不保存原始来源、不入队、不启动 worker、不调用 Codex、不发消息。输出只含时间、数量、分页状态和缺口代码。检查 requested range、可读消息数、文件数、根/话题分页数和缺口后向 Ivy 汇报，再等待下一批准。

`visible_range_exhausted` 只表示可见分页结束，不等于租户全历史完整。观察到的最早/最晚消息时间也不证明区间内无缺失；权限、删除、未知 sender、不可读文件或话题仍须披露。

## 4. Persist（保存来源与审计，仍不发送）

单独批准数据库写入/必要的 additive migration 与明确备份。确认以下三开关全部为 `false`，避免回填时被后台立即分析/投递；CLI 手动 persist 不受这些后台开关代替授权。

```dotenv
FOUNDER_STREAM_CAPTURE_ENABLED=false
FOUNDER_STREAM_ANALYSIS_ENABLED=false
FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false
```

```bash
pnpm founder-stream:backfill -- --chat-id oc_a84d5b6ca478220d0a37964b50776edb --since 2026-09-01T00:00:00.000Z --until 2026-09-21T00:00:00.000Z --persist
```

记录本次 batch stable key、精确 source ID 集合、批准群与覆盖快照关联到受保护的审计清单（不放 Git/MEMORY），并保存来源集合校验值。重复相同 source-set 不重复生成分析任务，但不得据此声称所有文件都已进入语义归纳：当前批次分析只消费可信群文本与明确标记的妙记，文件可读快照保存并报告；文件的后续语义接入另验收。

先看 `/diag/founder-stream` 的 requested/observed window、类型/可用状态计数、话题阶段、open issue、queued/retry 和 founder outbox。source 计数是本库全部已持久化 Context 来源（可能含旧私聊会议 Context），topic/issue 是本库相应表聚合，outbox/jobs 仅计 founder 类型；它们不是“本批次处理量”。批次准确数量以审批清单与绑定查询为准。

诊断不返回聊天原文、摘要、身份 ID、群 ID、妙记 token、source/evidence ID、原始 locator 或任何游标/哈希。`cursorState` 只给 root/thread 存在性、数量、页状态和审计时间；恢复值留在受保护数据库，需另批准的定向检查，不能从诊断复制续页 token。损坏审计记为 invalid/UNKNOWN，不打印原始错误。

## 5. 分析与初始工作地图预览

只有另行批准后才运行分析：启用 capture，再启用 analysis，delivery 继续关闭。分析会消耗现有 Codex 订阅额度；没有直接模型 API 计费通道。

目前已提供 topic analyzer 与结构化观点/分歧注入端口。生产 server 尚未注入观点/分歧语义 adapter，缺省会安全地不生成观点或提醒；本地 fake E2E 不代表真实语义质量已验收。不得仅打开 flags 就宣布“双方自动对齐上线”。生产前需单独评审 adapter、身份配置及真实质量抽检。

没有独立的 `preview-map` CLI，也不自动发送初始化地图。开发者用现有 `renderFounderWorkMap` 对获批批次对应的 topic/evidence 生成本地预览（每页最多 12 项、跨页编号稳定），Ivy 审阅：已有项目、候选、探索、想法、暂停/结束、待确认归类和覆盖缺口。零项目时不虚构项目；不恢复九项目种子。渲染调用及预览文件落地也须放入具体变更单。

Ivy 明确批准“这份地图、这些页、这个群、这个批次/source-set”后，才可 enqueue 对应 `founder_work_map` 并单独启用 group delivery；不是默认私发 Ivy。必须收到真实投递回执再绑定回复编号。先检查 pending outbox，批准一张卡不能顺带批准历史积压卡。

增量开启顺序：capture → analysis → delivery。仅捕获不分析；分析不自动发送；只有行为方向、下一步、负责人、截止或验收标准的有证据分歧才提问。单方沉默/已读/收到不算共识。一方可停止提醒，但双方明确支持同一方案才形成共同决定。普通群讨论和妙记是同一 Context 底座，旧的未标记 Minutes 不会自动纳入；要纳入必须另行明确 backfill 与 approved target 标记。

## 6. 媒体与缺口

视频不下载不解析；普通音频文件不下载不解析。原生语音仅在已获批转写能力与费用权益确认后可转文字，本阶段未提供自动 ASR 的新增生产授权；缺文字记录 `VOICE_TEXT_MISSING`。图片文本提取未获批则跳过并记录缺口。文件无权限/不支持/缺文本都保留 gap，不能掩盖成“已完整同步”。未知身份只留 Context，不猜归属。

## 7. 暂停与回滚

异常先暂停并报告：停止新增群投递是第一层；按明确授权依次关闭 delivery、analysis、capture，停止对应 consumer。共享 worker 的重启影响既有会议链路，必须说明影响并单独批准。保留待处理任务、原始来源、失败状态和 outbox，不通过删库来“恢复健康”。

代码回滚使用已验证旧 commit/image；数据库为 additive schema，优先保留新表审计并关闭新功能。需要数据库恢复时先停止写入、使用本次专属权限 600 的 SQLite 一致性备份、校验 integrity/foreign keys，并记录可能丢失的备份后事件。不能覆盖其他会议链路后续数据；有共享写入必须先制定增量恢复方案。只有预先授权的紧急回滚才可在生产不可用时直接执行。

## 8. 按 batch + approved chat + source-set 撤销/删除边界

没有通用 purge/delete CLI；不要使用不存在的命令，也不要用宽范围 `rm`、`DROP TABLE`、按日期删除整表、删除整库或仅凭群 ID 批量删除。

先另批准只读预览，在受保护的数据库副本上准备参数化清单：`:batch_key`、`:approved_chat`、`:approved_source_ids_json`。source-set 必须与所选 batch payload 完全一致，且每个来源的 metadata.chatId（群消息/群文件/coverage）或明确 founderStreamChatId（妙记）匹配批准群。ID 清单不打印到公开诊断。以下是针对已确认清单的只读计数模板，不执行删除：

```sql
WITH approved(id) AS (SELECT value FROM json_each(:approved_source_ids_json)),
batch AS (SELECT payload FROM batch_jobs WHERE stable_key=:batch_key
  AND type='analyze_founder_stream_batch' AND json_extract(payload,'$.chatId')=:approved_chat)
SELECT
 (SELECT COUNT(*) FROM batch) AS matched_batches,
 (SELECT COUNT(*) FROM approved) AS requested_sources,
 (SELECT COUNT(*) FROM context_sources s JOIN approved a ON a.id=s.id
   WHERE json_extract(s.metadata_json,'$.chatId')=:approved_chat
      OR (json_extract(s.metadata_json,'$.founderStreamEligible')=1
          AND json_extract(s.metadata_json,'$.founderStreamChatId')=:approved_chat)) AS matched_sources,
 (SELECT COUNT(*) FROM context_evidence e JOIN approved a ON a.id=e.source_id) AS dependent_evidence,
 (SELECT COUNT(*) FROM context_extraction_run_sources r JOIN approved a ON a.id=r.source_id) AS extraction_links;
```

还须双向比较 batch `sourceIds` 与清单的差集均为空、无重复 ID；检查来源关系、topic_sources、evidence、perspective/observation、issues、feedback、其他 jobs/outbox、Phase 1E candidates/records 和旧会议引用。大批次分片后要记录父/子批次映射，不能只删父任务。coverage/gap snapshots 不在分析 source-set 中，若也要删必须以相同窗口/群的独立精确清单重新批准。

只有预览计数、引用影响、实际行清单和可恢复备份获 Ivy 批准，才进入事务。事务开始后重查相同计数和 source-set，任何变化或不明关联立即 ROLLBACK：

1. 先冻结该批次的执行/投递，确认无 processing lease；保留冻结前状态在专属审计备份。仅将该 batch 及获批子批次的 queued/retry jobs 标为 failed（非物理删除），pending outbox 仅对精确批准消息 ID 标为 cancelled；不要扩大到同群其他任务。
2. 对**未生成 evidence、无任何引用的来源**，可在经审查的参数化事务内按批准 ID 集合删除来源，再删除对应已冻结任务；必须再次检查 metadata 群边界与 rows affected 等于预览数量。来源关系/提取链接/topic-source 等任一引用存在就不适用此简化路径。
3. 已形成共享 topic/观点/会议/记录的来源，先停止物理删除。需要另写“精确引用图 + 保留共享成果或重建方案”的 scoped migration，在备份副本演练、测试恢复、复核后重新审批；不能级联删除整个 topic 来绕过共同来源。
4. 事务内 `PRAGMA foreign_key_check` 必须无异常；提交后再次跑聚合诊断，并用受保护的预览清单核对只变动获批行。保存操作时间、操作者、batch/source-set 校验、前后计数、备份路径、结果；不把正文或密钥写入日志。

数据库删除不能撤回已经送达飞书的消息，也不是安全擦除所有备份；若要求永久删除/撤回，需要另确认备份保留期及已投递内容范围。默认选择可恢复的暂停/隔离，不伪称物理删除完成。

## 9. 本地验收与上线闸门

本地门：`pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`。`tests/founder-stream-e2e.test.ts` 使用内存 SQLite、fake 语义端口与 fake Feishu API，实际穿过历史读取→来源→动态话题→个人观点→群提问→群纠正→resolved receipt，无网络、无 Codex 进程。

通过此门之后仅可提交生产提案，不能直接部署。提案应包含精确时间、群/数据范围、身份、语义 adapter 缺口、权限核查、备份恢复、三 flags、dry-run 计数、首张地图预览、积压处理、删除/回滚边界以及每一步审批点。
