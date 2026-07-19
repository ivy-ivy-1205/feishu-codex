# MEMORY.md

## 项目概况

- 项目：Project 6 / FeishuAdaptor，是 AiJia Context OS 的飞书 × Codex Bridge MVP。
- 启动日期：2026-07-18。
- 当前工作区初始为空，`~/.codex/templates/` 在本机不存在，因此首次启动时创建了最小等价的 `AGENTS.md` 与 `MEMORY.md`。
- Ivy 已批准进入 Phase 1、通过书面 spec，并批准腾讯云服务器只读 Preflight。Phase 1A 本地 fixture 实现与最终分支复核已完成，并于 2026-07-18 合并到本地 `main`；尚未连接真实飞书或部署。

## 已确认边界

- 部署目标是腾讯云新加坡，不是 AWS 悉尼。
- Ivy 要求所有腾讯云服务器操作逐次事前审批：包括通过管理员/root SSH 入口登录、只读探测、安装、配置修改、部署和服务重启；未获得当次明确同意前不得执行任何服务器命令。
- 使用服务器本地 Codex CLI 和 Ivy 现有 ChatGPT/Codex 账号交互式登录。
- 不增加 OpenAI API Key，不自动切换 API，不产生额外 OpenAI API 按量费用。
- 本项目只允许用 Codex CLI + Ivy 现有 Codex/ChatGPT 账号实现 AI 执行；worker 只能做异步调度、重试、状态机和授权闸门，不得直接调用 OpenAI API、不得引入隐藏 token 费用。
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
- 所有 AI 总结、理解会议和 Todo 执行都必须通过本地 Codex runtime/CLI；低风险任务也只能在 Ivy 明确授权后进入 Codex CLI 执行链路，高风险动作继续要求二次确认。
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
- Phase 1A Task 4 的 meeting worker 复用 `batch_jobs.updated_at` 表示下一次可执行时间或可配置 lease 到期时间（默认 180 秒）；所有 ownership、persist 和状态 CAS 都要求相同决策时间满足 `leaseExpiresAt > now`，防止已到期但尚未被 reclaim 的 worker 落库。summary/Todos 与稳定键 `minute-summary:<minuteId>` 的 outbox 在同一 transaction 写入，delivery ack 再以单一 transaction 把真实消息 ID 绑定到 summary 并标记 outbox delivered，使回复能恢复 Todo；`meeting_summaries.minute_id` 唯一约束保证同一妙记只生成一次。
- Phase 1A Task 6 的授权采用 capability fail-closed：Todo capability 是数据库持久化闭集，旧记录回填 `unknown`；只有明确安全的 `content_draft` 且 risk 为 low 才能直接授权，缺失、未知、risk high 或代码写入/外发消息/部署/删除/生产访问一律进入二次确认。回复 lookup 还必须关联同一 minute 的 `minute-summary` outbox，且只有 delivery ack 后 `status=delivered` 并存在 `delivered_at` 才能解析 Todo，不能把 `om_` 字符串格式当成投递证明。
- Phase 1A 的 `/ready` 必须同时验证数据库可用和 durable-job consumer 可用；当前 server 尚未启动 worker consumer，因此应明确返回 `WORKER_UNAVAILABLE`，不能仅因 migration 成功就宣称 ready。
- Phase 1A worker 的 lease 默认 180 秒，且启动配置强制 lease 长于下游 Codex timeout；所有 job 终态/重试 CAS miss 必须显式返回 `lost_lease`，不能把失去所有权伪装为完成。`MINUTE_NOT_READY` 与 `RATE_LIMITED` 的计数以 `attemptsByCode` 分别持久化并跨 SQLite 重启延续，交替错误不会消耗对方预算；旧版共享 `attempt` 会保守映射到两类计数，非法 legacy payload 在 migration 时 fail closed。
- 结构化总结允许“没有已确认决策、没有已知风险、没有可执行 Todo”，这种情况下仍发送诚实总结并明确显示暂无 Codex 可推进事项。summarizer 输出在事务前执行字段、数组及整体 UTF-8 byte 上限校验，非法输出只保存 typed failure code。
- Phase 1A HTTP 服务默认只监听 `127.0.0.1`；只有显式配置 `HOST=0.0.0.0` 才监听所有接口。非测试环境拒绝仓库内 fixture verification token，防止占位凭据随公网监听误启动。
- 2026-07-18 本地已补齐腾讯云部署骨架但尚未部署：新增 Dockerfile、`.dockerignore`、`tsconfig.build.json`、`deploy/docker-compose.production.yml`、`deploy/bridge.env.example`、`docs/tencent-cloud-deployment.md`，并在 `package.json` 增加 `build`/`start` 与 `packageManager: pnpm@11.9.0`。生产 compose 计划绑定 `127.0.0.1:3010 -> container:3000`，数据挂载到 `/opt/feishu-codex/data/logs/codex-workdir`，secret env 文件位于 `/opt/feishu-codex/secrets/bridge.env` 且不入仓库。容器使用非 root `node` 用户，服务器可写目录需后续授权调整为 uid 1000 可写。
- 2026-07-18 为兼容 pnpm 11 build-script 安全策略，`pnpm-workspace.yaml` 显式只允许 `better-sqlite3` 与 `esbuild` 执行 build scripts；`.pnpm-store/` 已加入 `.gitignore`。本地验证使用 Codex bundled Node 完成：`pnpm build`、`pnpm typecheck`、`pnpm test` 全部通过（13 个 test files，91 tests）。
- 2026-07-18 按 TDD 新增 durable job consumer 基础设施：`src/services/job-consumer.ts` 提供 `DurableJobConsumer`，支持 start/stop、`isConsumptionAvailable()`、单次 lease/process、以及防止重叠 tick。新增 `tests/job-consumer.test.ts` 先红后绿验证 lifecycle、处理 leased `process_minute` job、防重入。生产 `/ready` 仍不能直接放行真实飞书事件，需等 consumer 接入真实 Feishu Minutes reader、summarizer 和 message delivery dependencies；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（14 个 test files，94 tests）。
- 2026-07-18 按 TDD 新增真实飞书适配器边界但尚未接官方 SDK：`src/adapters/feishu.ts` 定义内部最小 `FeishuApiClient`（`getMinuteBasicInfo`、`exportMinuteTranscript`、`sendTextMessage`），并提供 `FeishuMinutesReaderAdapter`、`FeishuMessageDeliveryAdapter`、`deliverPendingMeetingSummaries`。adapter 会把空 transcript 映射为 `MINUTE_NOT_READY` 供 durable worker 重试，并在 outbox delivery 后把真实飞书 `messageId` ack 回 SQLite。新增 `tests/feishu-adapters.test.ts` 先红后绿验证 minute normalization、retry mapping、私聊发送和 outbox delivery ack。官方飞书 SDK client 仍需后续在真实凭据和 Ivy 授权下实现；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（15 个 test files，98 tests）。
- 2026-07-18 按 TDD 新增 Codex CLI 执行边界但尚未接入生产 worker：`src/adapters/codex-cli.ts` 提供 `CodexCliAdapter` 与 `NodeCodexProcessRunner`，固定构造 `codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <json>`，通过 stdin 发送任务输入，并从子进程环境剥离 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_ORG_ID`、`OPENAI_PROJECT_ID`、`ANTHROPIC_API_KEY`，防止偷偷 fallback 到 OpenAI API 或其他模型 API。新增 `tests/codex-cli-adapter.test.ts` 先红后绿验证只读 CLI flags、API env 清理、非法 JSON typed failure、非零退出 typed failure 和底层 spawn/stdin/stdout/stderr 行为。README 与腾讯云部署说明已更新为：adapter 已存在，但尚未部署、未自动执行 Todo、未接入生产 worker。
- 2026-07-18 在 Codex CLI adapter 中补入 Auth Gate：每次 `executeJson` 前先运行 `codex login status`，只有成功且显示 ChatGPT 登录状态才继续 `codex exec`；未登录、登录过期或 API-key-like auth status 均 fail closed 为 `CODEX_AUTH_REQUIRED`，且不会运行 `exec`。新增测试覆盖已登录路径、未登录路径和非 ChatGPT 登录路径；部署文档已同步说明该 gate 不保存、不记录 Codex/ChatGPT 凭据。
- 2026-07-18 按 TDD 新增 `CodexMeetingSummarizer`，把 Codex CLI JSON executor 接到现有 `MeetingSummarizer` port，但尚未接入生产 worker：`src/adapters/codex-summarizer.ts` 会把 minute 元数据与逐字稿渲染成 Ivy 个性化总结 prompt，传入固定 JSON output schema，再用现有 Zod `MeetingSummaryDraft` 做权威校验，非法结构仍 fail closed 为 `SUMMARIZER_OUTPUT_INVALID`。新增 `CODEX_SUMMARIZER_MODE=fake|codex` 配置，默认 `fake`，只有显式 `codex` 才允许后续 worker wiring 使用真实 Codex summarizer；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（17 个 test files，107 tests）。
- 2026-07-18 按 TDD 新增 production summarizer dependency composition：`src/composition/meeting-summarizer.ts` 根据 `CODEX_SUMMARIZER_MODE` 返回 fake summarizer 或 `CodexMeetingSummarizer + CodexCliAdapter + NodeCodexProcessRunner` 栈；`src/server.ts` 启动时会组装该 summarizer，但仍不启动 durable-job consumer，`/ready` 继续阻塞真实飞书 webhook activation。新增 `tests/meeting-summarizer-composition.test.ts` 覆盖默认 fake、显式 codex、CLI 配置传递；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（18 个 test files，110 tests）。
- 2026-07-18 按 TDD 细分 `/ready` gate 缺口：`createServiceReadiness` 现在可返回 `READINESS_BLOCKED` 与 blockers 数组，当前 server 明确报告 `FEISHU_READER_UNAVAILABLE`、`FEISHU_DELIVERY_UNAVAILABLE`、`WORKER_CONSUMER_UNAVAILABLE`、`CODEX_AUTH_UNAVAILABLE`；数据库故障仍单独返回 `DATABASE_UNAVAILABLE` 且不泄露错误。新增/更新 `tests/health.test.ts` 覆盖多 blocker、探针异常 fail closed 与 ready 成功路径；本地/部署文档已同步；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（18 个 test files，111 tests）。
- 2026-07-18 按 TDD 抽出可复用 `CodexAuthProbe`：它复用 Codex process runner，运行 sanitized `codex login status`，只接受成功的 ChatGPT 登录状态；未登录、API-key-like auth 或命令失败都返回 unavailable，不抛出 stderr/secret。`CodexCliAdapter.executeJson` 改为复用该 probe，composition 的 codex 栈也暴露 authProbe；当前 server `/ready` 仍不真实调用 probe，继续报告 `CODEX_AUTH_UNAVAILABLE`，等目标服务器安装 Codex CLI 并由 Ivy 交互式登录后再接入。新增 `tests/codex-auth-probe.test.ts`；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（19 个 test files，114 tests）。
- 2026-07-18 按 TDD 新增飞书官方 SDK client skeleton：依赖 `@larksuiteoapi/node-sdk@1.71.1`，`src/adapters/feishu-sdk.ts` 提供 `createFeishuSdkClient` 与 `FeishuSdkApiClient`，固定自建应用 `AppType.SelfBuild` + `Domain.Feishu`、silent logger、`client.im.message.create` 文本发送、`client.minutes.v1.minute.get` 妙记基础信息、`client.minutes.v1.minuteTranscript.get` 逐字稿下载入口。新增 `tests/feishu-sdk-client.test.ts` 用 fake SDK client 验证参数形状和 message ID fail closed；未填真实凭据、未发网络请求、未接入生产 worker。注意 SDK transcript API 返回二进制流，stream-to-transcript parser 尚未实现；pnpm build-script 白名单新增 `protobufjs`，全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（20 个 test files，118 tests）。
- 2026-07-18 按 TDD 新增 minute transcript stream parser 并接入 SDK skeleton：`src/adapters/minute-transcript-parser.ts` 把 JSON stream 解析为内部 `TranscriptSegment[]`，支持数组、`segments`/`transcript` 包裹，以及 `speakerName/speaker_name/speaker`、`startMs/start_ms/start_time`、`endMs/end_ms/end_time`、`text/content` 字段别名；非法 JSON、空字段、时间倒挂等 fail closed 为 `MINUTE_TRANSCRIPT_INVALID`。`FeishuSdkApiClient.exportMinuteTranscript` 现在会解析 SDK `getReadableStream()` 返回的 transcript stream；如果真实飞书 transcript 文件格式不同，应更新 parser fixture，不改 worker contract。新增 `tests/minute-transcript-parser.test.ts`，更新 `tests/feishu-sdk-client.test.ts`；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（21 个 test files，123 tests）。
- 2026-07-18 按 TDD 新增 Feishu SDK reader/delivery composition：`src/composition/feishu.ts` 把 `createFeishuSdkClient`、`FeishuSdkApiClient`、`FeishuMinutesReaderAdapter`、`FeishuMessageDeliveryAdapter` 组装成内部 `reader/delivery` 端口；`src/server.ts` 启动时会构造该栈，但仍不启动 worker、不调用飞书网络、不把 Feishu probes 接入 `/ready`。`/ready` 继续报告 `FEISHU_READER_UNAVAILABLE`、`FEISHU_DELIVERY_UNAVAILABLE`、`WORKER_CONSUMER_UNAVAILABLE`、`CODEX_AUTH_UNAVAILABLE`，直到 Ivy 批准真实凭据与真实联调。新增 `tests/feishu-composition.test.ts`；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（22 个 test files，125 tests）。
- 2026-07-18 按 TDD 新增 worker runtime 的最后一道假门：配置新增 `WORKER_ENABLED=false|true`（默认 false）与 `WORKER_POLL_INTERVAL_MS`；`src/composition/worker-runtime.ts` 在 disabled 时不 lease job、不消费、不投递，enabled 时把 `Feishu reader → Meeting summarizer → processMinuteJob → outbox delivery ack` 串成一个 durable consumer cycle。`src/server.ts` 已接入该 runtime，默认只组装不启动，显式 `WORKER_ENABLED=true` 才启动 consumer；`CODEX_AUTH_UNAVAILABLE` 仍保持 fail-closed，真实飞书/Codex 联调和部署仍需 Ivy 单独批准。更新 `.env.example`、`deploy/bridge.env.example` 与 docs；全量验证更新为 `pnpm build`、`pnpm typecheck`、`pnpm test` 通过（23 个 test files，128 tests）。

## Phase 0 Preflight 结果

- 当前本机是 macOS 26.1 arm64，10 CPU、16 GiB 内存、约 150 GiB 可用磁盘；它不是腾讯云目标环境。
- Git 2.50.1 与 Codex CLI 0.145.0-alpha.18 可用；PATH 中没有 Node.js、npm、Docker。
- 尚未检查目标服务器、域名、HTTPS、飞书应用、PostgreSQL 和目标服务器 Codex 登录。
- Ivy 已批准进入 Phase 1；消息范围已确认为白名单群全部历史与文件。
- 消息范围已经由 Ivy 确认为白名单群全部历史与文件。
- `~/.ssh/config` 中发现腾讯云候选别名 `aijia-tencent`、`aijia-openclaw`、`realagent-prod`；均指向同一候选主机但账号不同。Phase 2 优先尝试最低权限别名，不默认使用 root。
- 本机 SSH 配置确认 `realagent-prod` 使用 `root@43.156.249.40`；2026-07-18 经 Ivy 逐次批准完成 SSH 握手诊断：服务器主机密钥与本地 known_hosts 匹配，指定私钥获服务器接受，root 公钥认证成功，远程只执行 `true` 并以状态 0 退出。该入口已验证可用，但任何后续服务器命令仍需另行批准。
- 2026-07-18 经 Ivy 批准使用 `realagent-prod` 完成只读 Docker/Nginx 拓扑检查：公网 80/443/8443 由生产容器 `realagent-nginx` 暴露；其镜像为 `nginx:alpine`、restart policy 为 `unless-stopped`，Nginx 配置从 `/root/RealAgentAI_cc/nginx.conf` bind mount 到 `/etc/nginx/conf.d/default.conf`，证书目录 `/etc/letsencrypt` 和 ACME webroot `/var/www/certbot` 已挂载。另有 staging Nginx 容器 `nginx-staging` 暴露宿主 2096 到容器 8443；本次未读取 Nginx 配置内容、未读取环境变量、未修改服务器状态。
- 2026-07-18 经 Ivy 批准只读查看 `/root/RealAgentAI_cc/nginx.conf`：配置为单文件 Nginx conf，包含 80 端口 ACME challenge 与 HTTPS 跳转、`aijia.ai/www.aijia.ai` 到 `realagent.aijia.ai` 的 443 跳转、`realagent.aijia.ai` 443 生产反代到 `realagent-ai:8000` 与 `voice-adapter:8100`、以及 8443 staging 反代到宿主 `172.17.0.1:8002/2096`。Bridge 接入应新增独立 `feishu-codex.aijia.ai` server block 和独立证书，不应复用或改写现有 RealAgent 业务路径。
- 2026-07-18 经 Ivy 批准只读检查证书续签方式：服务器安装了 `/usr/bin/certbot`，现有证书包括 `aijia.ai`（ECDSA，有效至 2026-09-18）和 `realagent.aijia.ai`（ECDSA，有效至 2026-10-01）。自动续签由 root crontab 执行：每天 03:17 运行 `certbot renew --quiet`，deploy hook 会在续签后执行 `docker exec realagent-nginx nginx -s reload`；日志写入 `/var/log/certbot-renew.log`。`/etc/letsencrypt/renewal/` 下已有两个 renewal conf，本次未执行续签、未申请证书、未 reload 服务。
- 2026-07-18 经 Ivy 批准修改服务器 Nginx 配置：已备份 `/root/RealAgentAI_cc/nginx.conf` 到 `/root/RealAgentAI_cc/nginx.conf.bak.20260718T122537Z`，并追加 `feishu-codex.aijia.ai` 的 80-only ACME challenge server block（`/.well-known/acme-challenge/` 使用 `/var/www/certbot`，其他请求跳转 HTTPS）。`docker exec realagent-nginx nginx -t` 已通过；本次未 reload Nginx，运行态尚未加载该新配置。
- Ivy 指出 `/root/RealAgentAI_cc` 是 Amy/RealAgent 的部署路径，不应作为 Feishu Codex Bridge 的 workspace。Bridge 应使用独立目录（优先 `/opt/feishu-codex` 或类似独立路径）存放业务代码、env、数据和 compose；公网 80/443 的接入若短期仍需经过现有 `realagent-nginx`，也应把它视为共享边缘网关，而不是把 Bridge 部署进 RealAgent 产品目录。
- 2026-07-18 经 Ivy 批准已恢复 `/root/RealAgentAI_cc/nginx.conf` 到备份 `/root/RealAgentAI_cc/nginx.conf.bak.20260718T122537Z`；`docker exec realagent-nginx nginx -t` 通过，`server_name feishu-codex.aijia.ai` 已从该配置文件移除。本次未 reload Nginx，因此生产运行态仍未加载过此前的临时 block。
- 2026-07-18 经 Ivy 批准只读检查服务器目录布局：`/opt` 下已有独立项目 `/opt/market-intel-engine`（含 `docker-compose.yml`），说明 `/opt/<product>` 是可接受的独立服务布局；未发现共享 edge-nginx workspace。`/root` 下已有产品目录包括 `/root/RealAgentAI_cc`、`/root/RealAgentAI_staging` 和 `/root/realagent-daily-news`，Bridge 不应放入这些目录。
- 2026-07-18 经 Ivy 批准已创建独立服务器 workspace `/opt/feishu-codex`，包含 `app/`、`data/`、`logs/`、`config/`、`secrets/`。目录属主为 `root:root`；除 `secrets/` 为 `700` 外，其余为 `755`。本次未写入凭据、未部署代码、未启动服务。
- 2026-07-19 经 Ivy 批准完成云端只读 Preflight 2：通过 `realagent-prod` root 入口只读检查，服务器仍为 OpenCloudOS 9.4，当前时间 `2026-07-19T11:19:53+08:00`；`/opt/feishu-codex` 仍为空壳 workspace（`app/data/logs/config` 为 `755 root:root`，`secrets` 为 `700 root:root`），未发现 Bridge 代码、env 或容器。Docker 29.2.1、Docker Compose v5.0.2、Git 2.43.7 可用；Node/npm/pnpm/Codex CLI 均未安装。运行容器仍为 RealAgent/Amy 相关服务与 staging，公网 80/443/8443 由 `realagent-nginx` 占用并挂载 `/root/RealAgentAI_cc/nginx.conf`；当前 Nginx 配置没有 `feishu-codex.aijia.ai` server block。`feishu-codex.aijia.ai` 已解析到 `43.156.249.40`，HTTP 访问当前返回默认 Nginx 404。目标本地端口 3010/3000/8080 未监听，适合作为 Bridge localhost upstream 候选。certbot 2.8.0 存在，现有证书 `aijia.ai` 到期 `2026-09-18`，`realagent.aijia.ai` 到期 `2026-10-01`。本次未读取 secret 内容、未写文件、未安装、未重启、未部署。
- 2026-07-19 经 Ivy 批准已在服务器创建 `/opt/feishu-codex/secrets/bridge.env` 模板文件，权限为 `600 root:root`，内容只包含占位凭据与安全默认值：`HOST=127.0.0.1`、`CODEX_SUMMARIZER_MODE=fake`、`WORKER_ENABLED=false`。真实 `FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY` 尚未写入；后续由 Ivy 提供/填入，凭据值不得进入仓库或 MEMORY。本次未启动服务、未安装依赖、未修改 Nginx。
- 2026-07-19 Ivy 提供的飞书真实 `FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY` 已一次性写入服务器 `/opt/feishu-codex/secrets/bridge.env`，文件仍为 `600 root:root`；只验证了敏感项已设置且长度为 32，未在输出、仓库或 MEMORY 中记录值。安全开关仍为 `CODEX_SUMMARIZER_MODE=fake`、`WORKER_ENABLED=false`、`HOST=127.0.0.1`。
- 2026-07-19 经 Ivy 批准已部署 Bridge 容器但未公网暴露：当前已提交代码 `5f71d7f` 通过 `git archive` 上传到 `/opt/feishu-codex/app`，使用 `/opt/feishu-codex/app/deploy/docker-compose.production.yml` 构建镜像 `aijia/feishu-codex-bridge:local` 并启动容器 `feishu-codex-bridge`，restart policy 为 `unless-stopped`，容器用户为 `node`。宿主只监听 `127.0.0.1:3010 -> container:3000`；`/health` 本机返回 200，`/ready` 本机返回 503 `READINESS_BLOCKED`，blockers 为 `FEISHU_READER_UNAVAILABLE`、`FEISHU_DELIVERY_UNAVAILABLE`、`WORKER_CONSUMER_UNAVAILABLE`、`CODEX_AUTH_UNAVAILABLE`。`/opt/feishu-codex/data`、`logs`、`codex-workdir` 已调整为 UID 1000 可写（宿主显示为 `lighthouse:lighthouse`，对应容器内 `node` 用户）；`secrets/bridge.env` 仍保持 `root:root 600`。本次未修改 Nginx、未申请证书、未配置飞书后台 Webhook、未启用 worker 或真实 Codex。
- 2026-07-19 经 Ivy 批准已完成 `feishu-codex.aijia.ai` 的 Nginx + HTTPS 接入：备份 `/root/RealAgentAI_cc/nginx.conf` 到 `/root/RealAgentAI_cc/nginx.conf.bak.20260719T042041Z.feishu-codex`，新增 80 端口 ACME challenge + HTTPS redirect server block，使用 certbot webroot `/var/www/certbot` 成功申请证书 `/etc/letsencrypt/live/feishu-codex.aijia.ai/`，证书到期 `2026-10-17 03:22:27 GMT`。新增 443 server block 反代到 `feishu-codex-bridge:3000`，并把 `realagent-nginx` 连接到 `deploy_default` 网络；该网络修正备份为 `/root/RealAgentAI_cc/nginx.conf.bak.20260719T042158Z.feishu-codex-network-fix` 与 `/root/RealAgentAI_cc/nginx.conf.bak.20260719T042445Z.feishu-codex-proxy-fix2`。踩坑：`/root/RealAgentAI_cc/nginx.conf` 是单文件 bind mount，`sed -i` 会换 inode，容器继续挂旧 inode；最终通过 `docker restart realagent-nginx` 重新挂载新配置后生效。服务器本机验证：HTTP `feishu-codex.aijia.ai/health` 返回 301 到 HTTPS；HTTPS `/health` 返回 200；HTTPS `/ready` 返回 503 `READINESS_BLOCKED`。RealAgent Nginx 网关重启后仍响应（`realagent.aijia.ai` HEAD 返回 405，说明请求到达应用）。本次未配置飞书后台 Webhook、未启用 worker、未启用真实 Codex。
- 2026-07-19 飞书后台保存 Webhook 回调时出现 “Challenge code 没有返回”：只读日志确认请求已到达 `POST /webhooks/feishu/events`，但线上旧版 Bridge 对加密回调返回 400。根因是当前应用已配置 Encrypt Key，飞书会发送 `{ "encrypt": "..." }`，旧版 route 只支持明文 `type=url_verification`。本地已按 TDD 补充加密 payload 解密：`SHA256(FEISHU_ENCRYPT_KEY)` 作为 AES-256-CBC key，密文为 `base64(iv + encrypted_event)`；解密后复用现有 Verification Token 与 challenge 校验逻辑。验证：`pnpm typecheck`、`pnpm test`、`pnpm build` 均通过。该修复尚未部署到腾讯云。
- 2026-07-19 经 Ivy 批准已将 encrypted challenge 修复部署到腾讯云 Bridge：本地审计提交为 `2c938d9 fix: support encrypted feishu url verification`，服务器旧 app 备份为 `/opt/feishu-codex/app.backup.20260719T050654Z-2c938d9`，新镜像重建后容器 `feishu-codex-bridge` 状态为 healthy。验证：公网 HTTPS `https://feishu-codex.aijia.ai/webhooks/feishu/events` 的加密 URL verification 模拟返回 HTTP 200 与原始 challenge；`/health` 返回 200；`/ready` 仍按预期返回 503 `READINESS_BLOCKED`，因为 worker、真实 Feishu reader/delivery 与 Codex auth 尚未启用。本次未修改 Nginx、未启用 worker、未触碰 RealAgent。
- 2026-07-19 Ivy 保存飞书机器人与事件配置后，在飞书私聊 Codex Bot 发送测试消息；服务器只读日志确认真实请求已到达 `POST /webhooks/feishu/events`，但当前 Bridge 返回 400，SQLite 中 `batch_jobs`、`meeting_minutes`、`outbox` 均为 0，说明链路已通但真实 `im.message.receive_v1` payload 结构与当前 reply parser/事件 envelope schema 尚未完全匹配。下一步应先补非敏感诊断或 fixture 化真实 payload 结构，再修 parser；不得记录原始消息正文或 secret。
- 2026-07-19 按 TDD 补齐真实飞书私聊消息适配：直发私聊的空 `parent_id/root_id` 归一化为无回复上下文，`message_type=post` 的富文本消息会从 `content` 的 `tag=text` leaf 中提取文本；拒绝事件只记录非敏感结构诊断（key、event type、message type），不记录 raw body 或消息正文。部署提交 `317eacd fix: parse feishu post message callbacks` 后，Ivy 第三次私聊测试消息真实到达 `POST /webhooks/feishu/events` 并返回 200；SQLite `batch_jobs`、`meeting_minutes`、`outbox` 仍为 0，符合 worker 未启用状态。
- AWS 悉尼别名 `product-sydney-01` 明确不在本项目范围。
- Ivy 已授权并已使用 SSH 别名 `aijia-tencent` 执行只读 Preflight；该别名解析为非 root 用户。
- 2026-07-18 已通过 `aijia-tencent` 完成只读 Preflight：OpenCloudOS 9.4、2 vCPU、3.6 GiB RAM、根盘余约 20 GiB；Docker/Compose/Git 可用，Node/npm/Codex 缺失。
- `hermes-user` 无 Docker socket 权限；服务器已有 OpenClaw、cloudflared 与多个公网端口，代理和容器拓扑未完整可见，部署前必须补充审计。

## 凭据位置

- 腾讯云 SSH 配置位于 `~/.ssh/config`，对应私钥位于 `~/.ssh/`；只记录位置，不记录密钥内容。
- 飞书企业自建应用 App ID 为 `cli_aad1fef1c7b81bda`；App Secret 已由 Ivy 创建但尚未写入服务器，后续仅存放于腾讯云运行环境的 Secret/环境变量，不进入仓库或本文档。
- 服务器运行环境凭据文件位置为 `/opt/feishu-codex/secrets/bridge.env`；文件已创建为 root-only 模板，但敏感值仍是占位符。
- 2026-07-18 已在飞书开发者后台为 Codex 应用开通：`im:message:send_as_bot`、`minutes:minutes.basic:read`、`minutes:minutes.transcript:export`，以及“读取用户发给机器人的单聊消息”；妙记基本信息与转录文本的数据范围限制为“公开妙记的所有者包含与应用可用范围一致”。
- 已订阅 `im.message.receive_v1`（应用身份）和 `minutes.minute.generated_v1`（用户身份），两项所需权限均显示已开通；后者需要 Ivy 用户 OAuth，不能据此假设覆盖全公司所有人的妙记。
- 飞书后台当前事件接收方式为长连接，而 Phase 1A 代码按 Webhook 实现；发布前必须二选一并补齐对应运行时，当前未创建或发布新版本。
- Ivy 于 2026-07-18 明确倾向保留 Webhook；只读核对确认腾讯云主机 `43.156.249.40` 已开放 80/443，并由容器化 Nginx 提供公网 HTTPS，因此不需要为了缺少 HTTPS 而改成长连接。
- `aijia.ai` 当前解析到 `13.239.49.33`（AWS），不是腾讯云；腾讯云现有 `realagent.aijia.ai` 解析到 `43.156.249.40`，Let's Encrypt 证书有效至 2026-10-01，但该域名已承载现有 RealAgent 服务，不应复用其业务路径作为飞书回调。
- 建议为 Bridge 新增独立子域名 `feishu-codex.aijia.ai`，解析到腾讯云 `43.156.249.40`，由现有 Nginx 单独反代到 Bridge 的 localhost 端口；截至核对时 `feishu.aijia.ai`、`codex.aijia.ai`、`webhook.aijia.ai`、`feishu-codex.aijia.ai` 均无 DNS 记录。
- Ivy 已添加 `feishu-codex.aijia.ai` A 记录到 `43.156.249.40`，且未开启 Cloudflare 橙云代理；2026-07-18 本机默认解析器、`1.1.1.1` 与 `8.8.8.8` 均已解析到 `43.156.249.40`。
- “测试企业和人员”当前无测试企业；创建测试企业会建立隔离组织，尚未执行。
- Encrypt Key 与 Verification Token 的后台位置为“开发配置 → 事件与回调 → 加密策略”；仅在事件/回调发送到开发者服务器时生效，长连接模式无需配置。凭据值不得写入仓库或本文档。
