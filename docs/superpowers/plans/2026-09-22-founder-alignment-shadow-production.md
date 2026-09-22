# AiJia Founder Alignment Room Shadow Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在唯一批准群中持续采集消息、附件与已关联妙记，更新双方工作地图和候选分歧，但绝不向群内发送任何 Founder Alignment 消息或执行 Todo。

**Architecture:** 沿用现有 Webhook、SQLite durable jobs 与服务器本地 Codex CLI。生产影子模式使用 `capture=true / analysis=true / groupDelivery=false`，但在本地补丁中进一步保证 delivery 关闭时不创建 outbox；附件通过异步 job 下载、内存解析后只保存有界文本，原始二进制不持久化。语义分类进入常驻 worker，使项目、原则、产物、研究和历史使用同一套规则。

**Tech Stack:** Node.js 20+、TypeScript、Fastify、飞书官方 Node SDK、SQLite、Docker Compose、服务器本地 Codex CLI。

**Spec:** `docs/superpowers/specs/2026-09-20-founder-stream-alignment-design.md`

## Global Constraints

- 唯一数据范围：`oc_a84d5b6ca478220d0a37964b50776edb`。
- 不读取其他群或私聊；视频和普通音频不下载；飞书原生语音仅在既有转写边界内处理。
- 不调用 OpenAI API，不引入 API Key fallback；AI 仅使用服务器现有 Codex CLI/ChatGPT 登录态。
- 原始消息和附件提取文本保留 90 天；不保存附件二进制；过期内容按现有 retention/redaction 机制清除。
- `FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false` 时，不发送群消息，也不得创建将来可被补发的 outbox。
- 不执行 Todo，不创建 Codex 执行任务，不修改客户系统。
- 部署、数据库迁移、生产配置修改和服务重启须在本变更单获 Ivy 明确批准后执行。

---

### Task 1: 封闭影子提醒与未来补发风险

**Files:**
- Modify: `src/services/alignment-notification-policy.ts`
- Modify: `src/services/founder-stream-worker.ts`
- Test: `tests/alignment-notification-policy.test.ts`
- Test: `tests/founder-stream-worker.test.ts`

**Interfaces:**
- Produces: `recordShadowCandidate(candidate, now)`，只保存 `alignment_issues.status='candidate'`，不创建 outbox。
- Preserves: `prepare(candidate, message, now)` 仅供 delivery 已开启时创建 `ready + outbox`。

- [x] 写失败测试：`groupDeliveryEnabled=false` 时可保存候选 issue，但 Founder/Alignment outbox 增量必须为 0。
- [x] 写失败测试：之后把 delivery 切为 true，不得发送影子期创建的 candidate。
- [x] 实现独立影子记录路径；worker 根据 `groupDeliveryEnabled` 选择 shadow 或 delivery 路径。
- [x] 运行专项测试并确认无 outbox 可补发。
- [x] 提交：`fix: isolate founder shadow candidates from delivery`

### Task 2: 将语义分类接入常驻工作地图

**Files:**
- Modify: `src/composition/founder-stream-analysis.ts`
- Modify: `src/services/founder-stream-worker.ts`
- Reuse: `src/adapters/codex-founder-work-map-classifier.ts`
- Reuse: `src/services/founder-work-map-classification.ts`
- Test: `tests/founder-stream-worker.test.ts`
- Test: `tests/minute-founder-stream.integration.test.ts`

**Interfaces:**
- Consumes: `classifier.classify(analysis)` 与 `projectFounderWorkMap(analysis, classification)`。
- Produces: 只有 `project | idea` 进入活跃 topic 层；principle/artifact/research 作为项目支持项；completed artifact 进入历史。

- [x] 写失败测试，覆盖情绪价值、EP00、VibeVoice、PropHero 和合伙人对齐室的常驻分类。
- [x] 在 topic reconciliation 之前执行分类，事实校验仍使用原文名称，规范名称仅写入展示/别名层。
- [x] 保证人工纠正优先于后续模型建议。
- [x] 运行专项测试。
- [x] 提交：`feat: apply founder semantic classification in worker`

### Task 3: 为新附件增加异步文本采集

**Files:**
- Modify: `src/services/founder-stream-worker.ts`
- Modify: `src/repositories/job-repository.ts`
- Modify: `src/composition/feishu.ts`
- Reuse: `src/services/feishu-file-context.ts`
- Test: `tests/founder-stream-worker.test.ts`
- Test: `tests/feishu-file-context.test.ts`

**Interfaces:**
- Produces: `capture_founder_attachment` durable job。
- Persists: 可进入既有 group-message evidence 管线的有界文本 source，以 attachment metadata 标识文件来源，`rawTextExpiresAt = capturedAt + 90 days`。
- Never persists: 原始附件二进制。

- [x] 写失败测试：文件消息先落审计记录并入队，不在 webhook 请求内下载。
- [x] 写失败测试：支持的 Markdown/HTML/DOCX/XLSX 只保存有界文本；ZIP 只保存安全目录；视频/音频跳过。
- [x] 写失败测试：下载、解析或权限失败形成 gap，不能伪装成完整读取。
- [x] 实现异步下载、内存解析、90 天 retention 元数据和幂等 stable key。
- [x] 运行专项测试。
- [x] 提交：`feat: capture founder attachment text asynchronously`

### Task 4: 固化影子诊断，不暴露正文

**Files:**
- Modify: `src/routes/founder-stream-diagnostics.ts`
- Test: `tests/founder-stream-diagnostics.test.ts`

**Interfaces:**
- Produces aggregate fields: `shadowCandidates`, `shadowCandidatesByReason`, `lastAnalysisAt`, `sourcesByType`, `gapsByCode`。
- Forbidden: 消息正文、附件正文、人员 ID、job/outbox payload。

- [x] 写失败测试验证聚合数字可见、正文和身份不可见。
- [x] 增加影子候选、最后分析时间、附件来源和缺口聚合。
- [x] 运行专项测试。
- [x] 提交：`feat: expose safe founder shadow diagnostics`

### Task 5: 本地发布闸门

**Files:**
- Modify if needed: `deploy/bridge.env.example`
- Test: `tests/config.test.ts`
- Test: `tests/deploy-contract.test.ts`

- [ ] 验证配置必须是：

```dotenv
FOUNDER_STREAM_CAPTURE_ENABLED=true
FOUNDER_STREAM_ANALYSIS_ENABLED=true
FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false
PROJECT_CONTEXT_CHAT_IDS=oc_a84d5b6ca478220d0a37964b50776edb
```

- [ ] 若生产 `CODEX_TIMEOUT_SECONDS=300`，设置 `WORKER_LEASE_SECONDS=660`，满足 `lease > 2 × Codex timeout`；Preflight 若显示不同 timeout，则按同一公式计算，不猜测。
- [x] 运行全量测试、typecheck、build、`git diff --check`。
- [x] 确认镜像内 migration、retention CLI、Founder worker 和附件解析依赖齐全。
- [ ] 建立本地审计 checkpoint commit。

### Task 6: D1 生产只读 Preflight

**Production writes:** 无。

- [ ] 核对运行 commit/image、三个 Founder flags、`WORKER_ENABLED`、Codex timeout/lease、批准群白名单。
- [ ] 核对 SQLite schema、`integrity_check`、数据库大小、磁盘余量。
- [ ] 记录所有 job/outbox 状态；尤其记录现有 `queued/retry/processing`，不消费、不修复。
- [ ] 核对 Codex 登录、`/health`、`/ready` 和 Bridge restart count。
- [ ] 若存在 schema 不一致、磁盘不足 5 GiB、Codex 未登录、非预期活动任务或当前服务不健康，停止部署。

### Task 7: D2 一致性备份与关闭态部署

**Production writes:** 创建可回滚备份、替换 app/image、修改四个非敏感 env 值、重建 Bridge。

- [ ] 用 SQLite `.backup` 创建部署前一致性快照并验证 `integrity_check=ok`。
- [ ] 保存当前 app、非敏感 env 状态和旧镜像回滚 tag；不复制或打印 secret 值。
- [ ] 上传带 SHA-256 的 release archive，在隔离目录构建新镜像。
- [ ] 停止 Bridge 后执行必要 migration；migration 失败立即停止后续步骤、保留现场并报告 Ivy，不自动恢复旧数据库或旧容器。
- [ ] 写入 Task 5 的四项配置，明确保持 `FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false`。
- [ ] 通过服务器 `tmux` 重建 Bridge；日志与退出状态写入独立文件。

### Task 8: D3 初始化与上线验证

**Production writes:** 一次性回填批准群固定 20 天文本和支持附件文本，然后开始持续增量。

- [ ] 对固定窗口执行幂等回填；不得读取窗口外群或其他聊天。
- [ ] 对附件只持久化有界文本并设置 90 天 expiry；记录不可读 gap。
- [ ] 验证 `/health=200`、`/ready=200`、Bridge `running/healthy`、restart count 无循环增长。
- [ ] 验证 `context_sources/topics/perspectives/alignment_issues` 有合理增量。
- [ ] 验证 Founder/Alignment outbox 增量严格为 0，飞书群消息增量严格为 0。
- [ ] 验证新发一条普通群消息后，5 分钟 debounce 结束可形成分析 job，并最终 completed。
- [ ] 清理 release 解包目录、构建缓存和一次性初始化容器；保留数据库备份、运行镜像、部署日志和最终状态文件。

## 停止与诊断条件

出现任一条件立即停止新处理和消息发送能力、保留现场并执行只读诊断；未经 Ivy 再次明确批准，不自动回滚 app/image/env 或数据库。若数据库完整性正在持续受损，先隔离写入并停止 Bridge，仍不擅自恢复快照：

- `/health` 或 `/ready` 在部署窗口内连续失败；
- Bridge restart loop 或 Codex auth unavailable；
- 读取到非批准群或私聊；
- Founder/Alignment outbox 新增、群消息被发送；
- Todo/Codex 执行任务被创建；
- 数据库 `integrity_check` 非 `ok`；
- 新 job 无界重试、持续 processing 或显著影响既有妙记链路。

## 首次 Review 时间点

- 上线后 24 小时：只看健康、来源数量、job 状态和零发送保证。
- 上线后 3 天：抽查候选项目、观点和分歧是否有来源支撑。
- 上线后 7 天：Ivy/James 决定继续影子、调整规则、停止，或另行审批开启群提醒。
- 开启群提醒必须是新的生产变更单；不得直接把 `GROUP_DELIVERY` 改为 true。
