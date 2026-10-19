# Phase 1E UAT Runbook（准备草稿，未获执行授权）

日期：2026-08-03  
状态：仅供下一轮独立 Implementation Review 与未来生产变更单准备；本轮不得执行

## 1. 前置 Gate

以下条件必须全部满足，才可由 Ivy 另行批准 UAT：

1. Phase 1E 修复轮获得独立只读 Implementation Review 的明确 `PASS`；
2. Ivy 批准精确 commit、release hash、执行窗口、操作者和回滚负责人；
3. Ivy 明确逐字稿保留期限、删除流程、访问权限和静态加密要求；
4. 两个 Phase 1E 开关以及 `PROJECT_CONTEXT_SYNC_ENABLED` 在预检时均为 `false`；
5. 生产队列没有未知的 queued/retry/processing job，现有已知旧 job 单独列出且不在本次处理；
6. 不执行 Todo，不访问历史群聊，不运行群历史 Context Sync。

任一条件缺失，立即停止，不进入备份、migration 或开关阶段。

## 2. 数据备份与 migration preflight

在获批窗口内执行，并保存脱敏证据：

1. 记录运行镜像、commit、env 中非敏感开关值及 SQLite 文件位置；
2. 用 SQLite 在线 `.backup` 创建部署前快照，权限保持 `600`；
3. 对备份和运行库执行 `PRAGMA integrity_check`，结果必须为 `ok`；
4. 只读记录 Phase 1D 核心表、job/outbox 状态与人工 project/rule 状态；
5. 对备份副本先执行 additive migration，确认 15 张 Context 表、外键、唯一索引及 outbox retry 列齐全；
6. migration 重跑一次，确认幂等且不改变 Phase 1D 行数、project archived 状态或 rule active 状态；
7. 任一检查失败，停止并保持所有开关为 false。

## 3. 分阶段启用 feature flags

不得同时开启两个开关：

1. 阶段 A：部署获批镜像，但保持 `CONTEXT_CANDIDATES_ENABLED=false`、`CONTEXT_REVIEW_ENABLED=false`；验证 `/health`、`/ready` 和原 Phase 1D 总结链路；
2. 阶段 B：仅开启 `CONTEXT_CANDIDATES_ENABLED=true`，保持 review false；只验证新会议的 Source、extraction job、typed failure 与 diagnostics，不发送审核卡片；
3. 阶段 C：阶段 B 证据通过后，经窗口内明确继续授权再开启 `CONTEXT_REVIEW_ENABLED=true`；验证 Ivy 私聊卡片；
4. 全程确认 `PROJECT_CONTEXT_SYNC_ENABLED=false`，不得读取历史群聊。

## 4. 测试数据范围

- 只使用 UAT 窗口内新创建的一场、由 Ivy 明确指定的测试会议；
- 不补抓旧妙记，不读取群历史，不扩展到聊天、文档或其他 Source Adapter；
- 会议内容使用无客户秘密的测试陈述，至少包含：决定、口头进展、blocker、纯 Todo，以及对既有测试 Context 的一个明确补充；
- 完整 Source 保存上限默认为 2,000,000 UTF-8 bytes / 10,000 segments；extractor 输入上限为 500,000 UTF-8 bytes / 2,000 segments。超限不得截断，只能产生脱敏 Context-only typed failure，并继续 Phase 1D 总结与 follow-up。

## 5. Ivy 私聊审核卡片验证

1. 卡片只投递到已绑定的 Ivy 私聊，message ID 与 outbox 正确绑定；
2. `source_attested` 文案只表示来源证明有人作出陈述或决定，`reported` 明确为尚未独立验证；
3. 普通“纳入 Context”即使存在 AI relation 建议，也只创建独立 Context，不写正式关系；
4. AI relation 必须标为“AI 建议，尚未确认”，只有 Ivy 点击服务端生成的显式 relation intent 后才生效；
5. supplements 当前版本同时包含旧正文与新增细节，旧版本不变，两份 Source/Evidence 均可反向追溯；
6. reject、needs clarification、conflict 不创建替换版本；重复点击不创建重复 review/version；
7. 错误身份、chat/message、nonce、过期卡或篡改 action 必须 fail closed；
8. 首次发送失败后，在没有新 Context job 时由后续独立 tick 按退避重试；过期 pending 卡必须换新 nonce/expiry 后再发送。

## 6. Rollback 条件与步骤

触发条件包括：Phase 1D 总结/follow-up 被阻断、错误关系自动生效、Evidence 无法精确定位、重复卡片、job/run 终态被旧 lease 覆盖、敏感正文进入日志/diagnostics、队列持续增长或健康检查失败。

获批回滚步骤：

1. 立即把 `CONTEXT_REVIEW_ENABLED=false`，停止新的审核投递；
2. 把 `CONTEXT_CANDIDATES_ENABLED=false`，停止新的 Source capture/extraction；
3. 确认 `PROJECT_CONTEXT_SYNC_ENABLED=false`；
4. 如代码回滚条件触发，恢复上一获批镜像和原 env，重启后验证 Phase 1D `/health`、`/ready`、总结、Todo 与 outbox；
5. additive Context 表不执行 destructive down migration，不删除候选、Source 或 Evidence；数据处置另开经 Ivy 批准的治理任务；
6. 只有数据库完整性受损且 Ivy 明确批准时才使用部署前备份恢复，并先保全故障库用于审计。

## 7. Transcript 数据治理待决项

- 完整逐字稿与备份的保留期限；
- 删除/撤权后的正文擦除、hash 和审计保留策略；
- SQLite、备份与传输的静态加密要求；
- 生产主机、备份、diagnostics 和 provenance 查询的最小访问权限；
- 敏感会议排除规则与用户通知方式。

上述事项未由 Ivy 决定前，不得开启生产 feature flag。

## 8. 验收证据与停止条件

证据包至少包含：获批 commit/release hash、变更单、pre/post backup 路径与 integrity 结果、migration schema/index 摘要、非敏感 env 开关值、单场测试会议 ID、job/run/outbox 终态、卡片 message ID、各审核动作结果、version/relation/provenance 查询结果、健康检查与回滚判定。

出现任何未预期外部调用、历史群聊读取、客户数据、Todo 执行、敏感日志、非终态队列或无法解释的重复记录，立即停止。完成证据收集后也必须停止，由 Ivy 单独作出 UAT 是否通过及是否继续部署的决定。
