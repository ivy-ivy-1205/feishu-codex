# MEMORY.md

## 项目概况

- 项目：Project 6 / FeishuAdaptor，是 AiJia Context OS 的飞书 × Codex Bridge MVP。
- 启动日期：2026-07-18。
- 当前工作区初始为空，`~/.codex/templates/` 在本机不存在，因此首次启动时创建了最小等价的 `AGENTS.md` 与 `MEMORY.md`。
- Ivy 已批准进入 Phase 1、通过书面 spec，并批准腾讯云服务器只读 Preflight。Phase 1A 实施计划已生成，尚未开始编码或部署。

## 已确认边界

- 部署目标是腾讯云新加坡，不是 AWS 悉尼。
- 使用服务器本地 Codex CLI 和 Ivy 现有 ChatGPT/Codex 账号交互式登录。
- 不增加 OpenAI API Key，不自动切换 API，不产生额外 OpenAI API 按量费用。
- MVP 不连接客户生产数据库，不持有生产凭据，不自动执行候选任务。
- 审批通过只把任务标记为 `APPROVED`，不得触发代码修改、命令执行或部署。
- 白名单群范围已确认为全部可见历史消息、全部话题回复、聊天附件及群内引用的飞书文件，不限于 @机器人消息。
- 电话、微信和邮件暂不自动接入；Ivy 可在 Codex 中手工补充，来源标记为 `manual_ivy`。
- 媒体策略：视频和普通音频文件跳过；飞书原生语音消息需要转文字。
- 首个白名单群 `chat_id` 为 `oc_a84d5b6ca478220d0a37964b50776edb`。
- 产品核心不是单纯的任务候选审批，而是解决公司 context 管理。飞书妙记是第一优先入口。
- 所有会议默认录制；妙记生成后应自动推送给 Codex，Codex通过飞书 Bridge 向 Ivy 发送个性化会议纪要和它能协助完成的 Todo。
- 生成 Todo 不代表获准执行。只有 Ivy 在后续对话中明确要求执行某个 Todo，才进入对应任务的执行授权流程。
- 主交互界面已确认为飞书：Bridge 把这里的 Codex 暴露成飞书 Bot；妙记自动进入同一 Codex context，纪要和编号 Todo 发回 Ivy 与 Bot 的聊天，Ivy 用“先干 1”等自然语言继续授权。
- Ivy 再次明确：执行指令通过回复飞书中的会议纪要机器人下达，不回到 Codex App 手工操作。
- Ivy 提供的参考交互是飞书 Bot 主动发送“会议信息 + 核心信息 + 我可以帮你推进（编号列表）”，Ivy 随后自然语言回复某项，Bot 直接交付低风险内容结果。
- 个性化会议总结、Todo、进度和结果默认发到 Ivy 与 Codex Bot 的私聊；验证效果后才考虑发到会议所属项目群，且群发布必须由 Ivy 明确指令触发。

## 待确认外部条件

- 腾讯云服务器访问方式、域名与 HTTPS 条件。
- 飞书应用是否已创建、应用凭据的 Secret 存放位置、测试群与审批人 ID。
- 服务器上 Docker、Node.js、Git、Codex CLI 及 Codex 登录状态。
- 腾讯云是否已有可复用 PostgreSQL；否则 MVP 使用持久化 SQLite。
- Ivy 审批用户真实 `open_id`、机器人是否可查看入群前历史、群是否为话题模式。
- Ivy 提供的 `oc_d851c3e986007dc0f97ab582bcb2e7c8` 已确认作为 Ivy 与 Codex Bot 的私聊 chat ID；它不是审批用户身份，不能用于操作者授权。
- 待确认“先干 1”的授权边界：是否允许低风险任务立即执行，而对代码修改、外部消息、部署和生产访问继续要求二次确认。

## 架构决策

- Phase 0 设计和 Phase 1 spec 均已通过。实施拆为四个计划，先完成 `meeting-to-todo-loop`，再做群历史回填、项目记忆、真实 Codex 执行和飞书/腾讯云联调。
- Phase 1A 计划位于 `docs/superpowers/plans/2026-07-18-meeting-to-todo-loop.md`，仅使用 fixture/fake 完成妙记到私聊 Todo 再到 Ivy 回复授权的本地闭环。
- GitHub 远端是 `ivy-ivy-1205/feishu-codex`；2026-07-18 只读检查无 refs，按空仓库处理。当前只做本地基线与分支提交，不自动 push。
- Phase 1A 不提前安装飞书 SDK，也不执行真实 Todo；官方 SDK 与真实 Codex 分别留到后续集成计划。
- MVP 采用 TypeScript + Fastify 单体、SQLite durable jobs/outbox、飞书官方 Node SDK、本地 Codex CLI worker。
- `better-sqlite3` 是需要 native build script 的直接依赖；项目根 `pnpm-workspace.yaml` 以 `onlyBuiltDependencies: [better-sqlite3]` 明确白名单化，使新环境可复现地构建 SQLite binding，而不放开其他依赖脚本。
- SQLite 的 Drizzle table declaration 与 `src/db/migrate.ts` 都是 schema source；两者必须使用相同名称与语义的约束，尤其是 `meeting_todos` 的编号、风险和状态 CHECK 约束。
- 保留需求指定的 Webhook；入口只做验证、白名单、幂等落库和入队，Codex 在异步 worker 执行。
- Codex 调用固定使用 read-only、ephemeral、ignore-user-config、output-schema、隔离工作目录和 stdin；应用层再次校验 JSON 与来源。
- SQLite 是单机 MVP 默认；只有腾讯云已有可复用 PostgreSQL 时才切换。
- 安全边界以“无自动执行代码路径 + Ivy-only 状态机 + OS 低权限隔离”为核心，不依赖 prompt 自律。
- 历史同步采用 chat 分页 + thread 二次分页 + 附件/文档引用解析 + 断点游标；完成后切换 Webhook 增量。
- 项目记忆采用不可变原始层和可版本化事实层，并输出同步覆盖率与缺口，不能把权限不可见内容算作已同步。
- 原生语音消息使用飞书官方 ASR 转写（MVP 处理 60 秒以内），无需 OpenAI API Key；转写成功后不长期保存原始语音。视频和普通音频文件按策略跳过。
- 飞书官方 ASR 文档未列出独立按次价格，但受语音识别权限、特殊频控和租户套餐/API 权益影响；默认关闭批量转写，先统计数量并由 Ivy 在费用中心确认权益。
- `oc_d851c3e986007dc0f97ab582bcb2e7c8` 用作私聊消息目标，不用作 Ivy 身份。Ivy 的 open_id 通过首次 `identify_approver` 回调安全发现。
- 订阅飞书 `minutes.minute.generated_v1` 作为会议 context 的主要触发器；不需要读取或处理会议录制视频本身。
- 飞书 Bridge 必须保存 `minute_id → summary_message_id/thread → todo_id → Codex task/session` 的关联，使后续自然语言指令能恢复同一会议与项目 context。
- 可见 Todo 编号只在对应 summary message/thread 内有效；缺少唯一 reply context 时必须澄清，不能猜测。
- 低风险内容工作可将 Ivy 的自然语言回复视为直接授权；高风险外部变更仍需明确影响说明与二次确认。
- 私聊 `oc_d851c3e986007dc0f97ab582bcb2e7c8` 是会议总结默认目的地，不自动向会议项目群发布。
- Phase 1A Task 3 的妙记接收把事件插入、minute 去重和 `process_minute` durable job 写入放在同一 SQLite transaction；job 的稳定键为 `minute:<minuteId>`，并要求两个 repository 共用同一 SQLite client。
- Phase 1A Task 3 的 SQLite migration 需要兼容 Task 2 旧版 `batch_jobs`：检测缺失 `stable_key` 后在 transaction 内重建表、保留所有旧 job，并用 `legacy:<id>` 回填唯一稳定键后再建立唯一索引。
- Phase 1A Task 4 的 meeting worker 复用 `batch_jobs.updated_at` 表示下一次可执行时间或 60 秒 lease 到期时间；所有 ownership、persist 和状态 CAS 都要求相同决策时间满足 `leaseExpiresAt > now`，防止已到期但尚未被 reclaim 的 worker 落库。summary/Todos 与稳定键 `minute-summary:<minuteId>` 的 outbox 在同一 transaction 写入，delivery ack 再以单一 transaction 把真实消息 ID 绑定到 summary 并标记 outbox delivered，使回复能恢复 Todo；`meeting_summaries.minute_id` 唯一约束保证同一妙记只生成一次。

## Phase 0 Preflight 结果

- 当前本机是 macOS 26.1 arm64，10 CPU、16 GiB 内存、约 150 GiB 可用磁盘；它不是腾讯云目标环境。
- Git 2.50.1 与 Codex CLI 0.145.0-alpha.18 可用；PATH 中没有 Node.js、npm、Docker。
- 尚未检查目标服务器、域名、HTTPS、飞书应用、PostgreSQL 和目标服务器 Codex 登录。
- Ivy 已批准进入 Phase 1；消息范围已确认为白名单群全部历史与文件。
- 消息范围已经由 Ivy 确认为白名单群全部历史与文件。
- `~/.ssh/config` 中发现腾讯云候选别名 `aijia-tencent`、`aijia-openclaw`、`realagent-prod`；均指向同一候选主机但账号不同。Phase 2 优先尝试最低权限别名，不默认使用 root。
- AWS 悉尼别名 `product-sydney-01` 明确不在本项目范围。
- Ivy 已授权并已使用 SSH 别名 `aijia-tencent` 执行只读 Preflight；该别名解析为非 root 用户。
- 2026-07-18 已通过 `aijia-tencent` 完成只读 Preflight：OpenCloudOS 9.4、2 vCPU、3.6 GiB RAM、根盘余约 20 GiB；Docker/Compose/Git 可用，Node/npm/Codex 缺失。
- `hermes-user` 无 Docker socket 权限；服务器已有 OpenClaw、cloudflared 与多个公网端口，代理和容器拓扑未完整可见，部署前必须补充审计。

## 凭据位置

- 腾讯云 SSH 配置位于 `~/.ssh/config`，对应私钥位于 `~/.ssh/`；只记录位置，不记录密钥内容。
- 飞书与 Codex 凭据尚未提供。仅可记录凭据所在 Secret 管理位置，不得记录凭据值。
