# Project 6：AiJia Context OS 飞书 × Codex Bridge MVP 设计规格

日期：2026-07-18  
状态：待 Ivy 书面复核  
范围：Phase 1 本地 MVP；不部署、不连接真实飞书、不自动执行任务

## 1. 产品目标

系统把 Codex 通过 Bridge 暴露为飞书 Bot，解决 AiJia 的公司 context 管理。飞书妙记是第一优先入口：妙记生成后自动进入 Codex context，Codex 按 Ivy 的偏好生成个性化会议总结与编号 Todo，并主动发送到 Ivy 与 Codex Bot 的飞书对话。Ivy 直接回复“先干 1”或用自然语言描述某项 Todo，Bridge 恢复对应会议、Todo 与 Codex session 后执行并回传结果。

系统也处理配置白名单中的飞书群。首次接入时，从最早可见时间开始回填该群全部消息、话题回复、允许处理的附件和消息中引用的飞书文档；随后使用 Webhook 增量同步。所有信息进入可追溯、可版本化的 AiJia 项目记忆。

妙记或总结自动生成 Todo 不构成执行授权。只有 Ivy 在飞书 Bot 对话中明确要求执行后，Todo 才能开始。低风险、可逆的内容工作可以直接执行；代码修改、对外发送、部署、删除和生产访问继续受高风险 Gate 保护。

首个白名单群：`oc_a84d5b6ca478220d0a37964b50776edb`。  
Ivy 与 Codex Bot 私聊：`oc_d851c3e986007dc0f97ab582bcb2e7c8`。会议总结、Todo、执行进度和结果默认只发到该私聊。

会议所属项目群不是默认发布目标。后续验证效果后可以增加“转发到项目群”，但每次发布必须由 Ivy 明确指令触发，不能因为会议属于某项目而自动共享。

## 2. 已选方案与替代方案

### 采用：单体服务 + SQLite durable jobs

一个 TypeScript/Fastify 服务提供 Webhook、只读状态接口和后台 worker。SQLite 同时保存业务数据、回填游标、持久化任务和 outbox；Codex 以独立子进程调用。

选择原因：单机内部 MVP 的核心问题是幂等、审计和重启恢复，不是横向扩展。SQLite WAL 与租约任务表能用最少运维满足这些要求。

### 未采用：Redis/BullMQ + PostgreSQL

队列能力更成熟，但会增加两个有状态依赖、备份面和部署复杂度。当前单机、单群规模不值得。

### 未采用：飞书长连接

本地开发方便，但原需求要求 Webhook、URL verification 和腾讯云公网入口。生产保留 Webhook；本地测试用 fixture，不接真实飞书。

## 3. 系统边界

允许：

- 白名单群全部授权可见历史消息与新增消息。
- 普通群消息、话题根消息和全部可见话题回复。
- 图片、普通文件和飞书文档引用的只读索引/读取。
- 飞书原生语音消息的可控转写。
- Ivy 在 Codex 中手工补充电话、微信、邮件形成的事实，来源标记为 `manual_ivy`。

禁止：

- 非白名单群、私人聊天和全企业扫描。
- 下载或分析视频。
- 下载或分析作为普通文件上传的音频。
- OpenAI API Key fallback、AWS、客户生产数据库。
- 从 `APPROVED` 自动触发任何执行。

## 4. 模块边界

### `config`

读取环境变量并在启动时做严格校验。敏感值只存在内存，不进入日志。白名单群、审批聊天和审批用户分别配置，不能混用。

### `feishu-ingress`

使用飞书官方 Node SDK 验证/解密事件和卡片回调。入口只做：验证、事件类型检查、chat allowlist、幂等落库、创建 durable job、3 秒内返回。

同时订阅 `minutes.minute.generated_v1`。妙记事件只负责创建持久化 job；逐字稿读取、总结与消息发送异步完成。

### `meeting-context`

接收妙记生成事件后，读取授权可见的会议元数据、逐字稿、智能纪要和说话人信息。录制视频本身不下载。输出保留 `minute_id`、`meeting_id`、时间、参会者、逐字稿来源和权限缺口。

逐字稿进入项目记忆前先分层：原始逐字稿不可变保存；事实、决策、风险、承诺和 Todo 由 Codex 结构化抽取并保留时间戳/说话人来源。

### `personalized-summary`

会议后默认向 Ivy 与 Codex Bot 的私聊发送一条轻量总结消息，视觉与交互参考 Ivy 提供的飞书截图：

```text
会议标题｜个性化会后总结
会议：...
时间：...

核心信息
• ...
• ...

我可以帮你推进
1. ...
2. ...
3. ...
```

总结不是通用摘要，应根据 Ivy 偏好突出：关键判断、已确定决策、未决问题、风险、对 Ivy 有意义的上下文，以及 Codex 真正能够协助完成的事项。不得把需要人际判断或线下行动的事项伪装成 Codex 可独立完成。

每个显示编号背后保存稳定 `todo_id`，并建立：

```text
minute_id → summary_message_id/thread_id → displayed_number → todo_id → codex_session_id
```

回复中的“1”“先干 1”只在被回复的总结消息/线程范围内解析。没有明确 reply context 且存在多个候选列表时必须澄清，不能猜测。

### `feishu-conversation`

Ivy 在与 Codex Bot 的飞书私聊里回复会议纪要，不需要回到 Codex App。Bridge 支持编号命令和自然语言，例如“先干 1”“把第二项写成可以直接发客户的版本”“整理进董事长主线”。

执行开始时 Bot 发送简短确认；长任务周期性发送可折叠进度；完成后直接交付结果并附来源会议。失败时说明失败位置、已完成部分和需要 Ivy 补充的信息。

### `history-sync`

按 `chat_id` 分页读取根消息；发现 `thread_id` 后按 thread 二次分页。每页保存游标后再继续，崩溃可恢复。同步结束生成覆盖率和缺口报告。

### `resource-policy`

根据消息类型决定处理：

- `video`：只记元数据，`SKIPPED_BY_MEDIA_POLICY`。
- 普通音频文件：只记元数据，`SKIPPED_BY_MEDIA_POLICY`。
- 飞书原生 `audio`：进入 voice pipeline。
- 图片与普通文件：在大小、权限和类型允许时下载并索引。
- 飞书文档链接：解析 token/type，通过对应只读 API读取；403 形成缺口。

### `voice-transcription`

飞书官方 ASR 只处理 60 秒以内原生语音，使用 `speech_to_text` 权限，不使用 OpenAI API Key。能力由 `FEISHU_VOICE_TRANSCRIPTION_ENABLED=false` 默认关闭：历史回填先统计语音数量，Ivy 确认套餐权益后再开启。另设每次回填最大转写数，达到上限后暂停并报告。

成功后保存转写文本、来源消息 ID 和识别状态，删除临时音频。超时、超长、限频、权限不足或识别失败写入 `sync_gaps`。

### `batcher`

实时消息按 `chat_id + thread/root key` 合并，默认 300 秒。历史消息按话题和时间窗口形成有上限的批次，避免把整个群一次性塞给 Codex。

### `codex-adapter`

调用：

```text
codex exec --sandbox read-only --ephemeral --ignore-user-config
  --output-schema <schema> --cd <isolated-workdir> -
```

消息从 stdin 输入。启动 Gate 要求 `codex login status` 明确为 ChatGPT 登录；未登录或认证方式不符返回 `CODEX_AUTH_REQUIRED`，绝不 fallback。应用层再次验证 JSON Schema、枚举、置信度、来源 ID 和任务创建条件。

### `project-memory`

两层存储：

1. 不可变原始层：消息、附件/文档引用、人工补充及来源。
2. 可版本化事实层：事实、决策、风险、任务更新、冲突、有效期和来源集合。

新信息与旧事实冲突时创建新版本并标记冲突，不静默覆盖。无来源条目不得进入事实层。

### `task-pack`

仅当 `classification=new_task_candidate`、`shouldCreateTask=true`、达到阈值且存在明确目标/问题/期望变化时创建 `PENDING_REVIEW`。低置信度只生成澄清问题。

会议 Todo 与传统 Task Pack 分开：Todo 是面向 Ivy 的短交互入口；当 Todo 涉及多步骤代码或外部变更时，Bridge 才把它提升成可审计 Task Pack。

### `approval`

`oc_d851...` 只作为 Ivy 与 Bot 的私聊目标。审批授权必须使用回调中的 `operator.open_id`（通常 `ou_...`）。

首次联调提供 `identify_approver` 动作：点击后只记录并展示操作者 open_id，不改变任务状态。Ivy 确认后把该 ID 放入 Secret 配置的 `FEISHU_APPROVER_USER_IDS`。在此之前所有批准动作拒绝并审计。

低风险 Todo 的 Ivy 自然语言回复本身就是执行授权，不要求额外审批卡。高风险 Todo 先返回将要发生的具体外部影响，再等待 Ivy 二次确认。

状态机：

```text
DRAFT → PENDING_REVIEW → APPROVED
                       → CHANGES_REQUESTED → PENDING_REVIEW（新版本）
                       → REJECTED
                       → ARCHIVED
```

## 5. 数据模型

- `feishu_events`：event ID 唯一、状态、哈希、接收时间、错误摘要。
- `source_messages`：message ID 唯一、chat/thread/root、类型、正文、发送者、时间、删除状态。
- `meeting_minutes`：minute/meeting ID、逐字稿与纪要状态、来源、参会者、时间和权限缺口。
- `meeting_summaries`：个性化总结、目标 chat/message/thread、偏好版本和发送状态。
- `meeting_todos`：稳定 todo ID、展示编号、能力类型、风险级别、状态、来源和 Codex session。
- `sync_cursors`：chat/thread 游标、最早/最晚可见时间、状态、恢复点。
- `message_resources`：资源 key、策略、MIME、大小、哈希、临时/持久位置、处理状态。
- `document_references`：token/type、来源消息、权限与版本、抽取状态。
- `batch_jobs`：合并键、not-before、状态、租约、attempt、错误。
- `codex_runs`：schema/CLI 版本、耗时、结果、错误码，不保存认证内容。
- `project_facts`：类型、正文、版本、确认/冲突状态、来源集合。
- `task_packs`：结构化任务、版本、状态、来源 batch。
- `approval_actions`：动作、操作者、前后状态、允许/拒绝原因、时间。
- `outbox`：待发送消息、业务幂等键、attempt 和发送状态。
- `sync_gaps`：权限、删除、保密、超限、不支持、策略跳过等缺口。

## 6. API

- `GET /health`：进程活着，不检查外部依赖。
- `GET /ready`：数据库 migration 完成、worker 可用、配置完整；Codex 未登录时返回不可就绪原因。
- `POST /webhooks/feishu/events`：事件订阅与 URL verification。
- `POST /webhooks/feishu/card-actions`：新版卡片动作。

不提供公开管理写接口。历史回填在 Phase 1 通过本地 CLI 命令触发，Phase 3 才由受控运维命令执行。

## 7. 错误与恢复

- 飞书重复事件：唯一约束返回已有结果，不重复创建 job/task/card。
- 妙记重复事件：`minute_id` 唯一，不重复总结或发送 Todo。
- 妙记尚未就绪：退避重试读取逐字稿，不发送空总结。
- “干 1”缺少唯一上下文：请求 Ivy 引用对应总结或复述 Todo，不执行。
- Webhook 处理失败：记录失败并返回适当状态；耗时工作绝不阻塞回调。
- worker 崩溃：租约过期后由下一轮恢复。
- 飞书 429/限频：指数退避并保存游标。
- Codex 超时/失败：有限重试；相同 batch 使用稳定幂等键，不重复建任务。
- 非法 AI JSON：拒绝业务写入，保存脱敏错误摘要。
- 审批竞态：数据库事务内校验当前状态和操作者，再原子更新。

## 8. 安全与隐私

- 服务使用专用低权限 Linux 用户；Codex 工作目录不挂载业务仓库或生产凭据。
- Secret 只由服务器 Secret/.env 权限文件提供，日志统一字段级脱敏。
- prompt 中的群消息视为不可信数据，不能改变系统安全约束。
- 审批聊天 ID 与审批用户 ID 分离校验。
- Todo 指令必须来自已验证的 Ivy `open_id`，并绑定回复的 summary message/thread；仅在目标聊天出现相同文字不构成授权。
- 会议总结默认私聊。向项目群发布属于外部可见副作用，必须由 Ivy 明确指定目标群并确认发布内容。
- 历史回填生成覆盖报告，不把不可见/跳过内容描述为完整读取。
- 为消息正文、临时语音与下载文件配置保留期；默认不长期保存语音原文件。

## 9. 测试规格

每项生产行为按 TDD 先写失败测试：

- URL verification、签名/解密适配、非白名单忽略。
- 妙记生成事件幂等、逐字稿未就绪重试、个性化总结结构。
- Todo 编号与 summary reply context 绑定，多会议并发时不串号。
- 自然语言 Todo 匹配、歧义澄清、执行进度与结果回执。
- event/message 幂等和重复推送。
- chat/thread 分页、游标恢复、话题二次回填。
- 媒体策略：视频与普通音频不下载，原生语音按开关/时长/额度处理。
- ASR 关闭、成功、超时、限频、权限不足和临时文件清理。
- 5 分钟合并、重启恢复和失败重试。
- Codex auth、只读 flags、stdin、schema、超时和非法 JSON。
- 分类门槛、事实溯源、冲突版本、Task Pack 内容。
- 审批聊天与操作者身份分离、identify flow、非 Ivy 拒绝、Ivy 状态变化。
- 批准后 canary 文件不变、无执行/部署/外发副作用。
- 日志不含 App Secret、Token、Codex 登录内容或完整敏感正文。

## 10. 非功能验收

- 服务重启后游标、任务、审批和 outbox 状态不丢失。
- Webhook 正常路径在 3 秒内响应，不等待 Codex 或 ASR。
- 所有事实和任务可追溯至 `message_id` 或 `manual_ivy` 来源。
- 每份会议总结和 Todo 可追溯至 `minute_id`、逐字稿片段和对应飞书消息。
- `/health` 与 `/ready` 语义不同且有自动测试。
- 本地 fixture 全绿后才能连接真实飞书。

## 11. 当前 Gate

- Ivy 复核本 spec 后，才能编写实施计划和开始 TDD 实现。
- 飞书真实联调前，需要应用凭据的 Secret 存放位置、最小权限授权、机器人入群与历史可见性确认。
- ASR 批量启用前，需要在飞书管理后台确认当前套餐的 AI/API 权益。
- 腾讯云任何安装、目录创建、配置、容器或服务变更，都需要单独部署批准。
