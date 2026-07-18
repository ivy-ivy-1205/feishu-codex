# Phase 0：只读 Preflight 与实施方案

日期：2026-07-18  
状态：Ivy 已于 2026-07-18 批准进入 Phase 1，并批准腾讯云服务器只读 Preflight；仍未部署、未创建云资源、未连接真实飞书。

## 1. 结论

Phase 1 已批准，但只做本地、fixture 驱动的 MVP。腾讯云服务器已完成有限只读 Preflight；由于域名/代理拓扑、飞书应用、Node.js、Codex CLI 与 Codex 登录仍未就绪，当前不能部署或进行真实飞书联调。

需求范围已确认不是“只处理新增消息”，而是对指定白名单群执行一次从最早可见时间开始的全量历史回填，包括普通消息、话题回复、聊天附件和消息中引用的飞书文件；回填完成后再由 Webhook 持续增量同步，并逐步形成 AiJia 项目记忆。

最小方案采用单体服务加单数据库：Fastify 接收 Webhook，SQLite 持久化事件、批次、事实、任务与审批，进程内持久化队列负责合并窗口和重试，独立 worker 子进程调用本地 `codex exec`。第一版不引入 Redis、消息队列、向量库、知识图谱、微服务或管理后台。

## 2. 已完成的只读 Preflight

### 2.1 当前本机

| 项目 | 结果 | 影响 |
| --- | --- | --- |
| 工作目录 | `/Users/mengxi/Projects/FeishuAdaptor`，初始为空 | Phase 1 需从零建立骨架 |
| 操作系统 | macOS 26.1 arm64，10 CPU，16 GiB 内存 | 仅是开发机，不代表腾讯云 Linux 环境 |
| 可用磁盘 | 约 150 GiB | 本地开发充足 |
| Git | 2.50.1 | 可用 |
| Codex CLI | `codex-cli 0.145.0-alpha.18` | 可做本地接口验证；生产应固定并记录已验证版本 |
| Node.js / npm | PATH 中不可用 | Phase 1 Gate：安装或提供 Node.js 20+ |
| Docker / Compose | PATH 中不可用 | Phase 1 可先原生运行；容器验收前必须补齐 |
| 项目文件 | 仅初始化约束与本设计文档 | 尚无源码、配置或测试 |

本次没有读取或输出任何凭据，也没有执行 Codex 登录检查，以免把开发机登录状态误当作目标服务器状态。目标服务器必须在 Phase 2 单独执行只读检查。

### 2.2 尚未检查的目标环境

- 腾讯云新加坡 Linux 服务器的系统、CPU、内存、磁盘、端口和已有服务。
- Docker、Node.js、Git、Codex CLI 的安装位置与版本。
- `codex login status` 是否明确为 ChatGPT 登录，而非 API Key。
- 域名、DNS、HTTPS 证书、公网 443、反向代理与防火墙。
- 飞书自建应用、权限、事件订阅、测试群、审批群与 Ivy 的用户 ID。
- 是否已有可复用 PostgreSQL；没有则采用持久化 SQLite。

### 2.3 已发现的 SSH 配置

- `~/.ssh/config` 中存在腾讯云候选别名：`aijia-tencent`、`aijia-openclaw`、`realagent-prod`，三者指向同一候选主机但使用不同 Linux 用户/密钥。
- `product-sydney-01` 属于 AWS 悉尼，明确排除在本项目之外。
- 初次发现配置时没有连接；Ivy 后续批准后已使用 `aijia-tencent` 完成只读 Preflight，全程未读取私钥内容或修改服务器。
- Phase 2 建议优先用最低权限的 `aijia-tencent` 做只读 Preflight；若权限不足，再由 Ivy 明确授权其他账号。不得默认使用 root。

## 3. 官方资料核对后的设计约束

### 飞书

- 订阅事件使用 `im.message.receive_v1`。业务已明确要求读取指定白名单群全部消息，因此需要申请“获取群组中所有消息”相关敏感权限，并将应用数据范围严格限制在指定群。
- 历史回填调用 `GET /open-apis/im/v1/messages`，以 `container_id_type=chat` 和白名单 `chat_id` 分页读取全部可见根消息；对于返回的 `thread_id`，再以 `container_id_type=thread` 分页读取全部话题回复。
- 聊天中的图片、音频、视频和文件使用 `GET /open-apis/im/v1/messages/:message_id/resources/:file_key` 获取，并保留内容哈希、MIME、大小、来源消息和失败原因。
- 消息中的飞书文档、电子表格、多维表格、知识库或云盘链接，需要解析 token 后调用对应只读 API 或导出 API；聊天消息权限本身不足以读取在线文档内容。
- 首个白名单群已指定为 `oc_a84d5b6ca478220d0a37964b50776edb`。
- Ivy 提供的审批 ID 候选值为 `oc_d851c3e986007dc0f97ab582bcb2e7c8`，但 `oc_` 通常表示 chat ID，而用户 open_id 通常以 `ou_` 开头；在通过飞书回调或用户信息接口验证前，不得加入审批人白名单。
- 需求明确指定 Webhook 与 URL verification，因此生产方案保留“发送至开发者服务器”，不改成长连接。
- 使用飞书官方 Node SDK 的事件分发器处理 Verification Token、Encrypt Key、URL verification、验签和解密，避免自行实现密码学细节。
- Webhook 和卡片回调必须快速响应；处理流程只做验证、白名单判断、幂等落库与入队，Codex 调用异步执行。
- 新版卡片回调类型为 `card.action.trigger`。审批身份以回调中的稳定用户 ID 与配置白名单比较；非 Ivy 操作返回拒绝提示并写审计记录。

### Codex CLI

- 调用形态固定为：`codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <schema> --cd <isolated-workdir> -`。
- prompt 和消息内容从 stdin 输入，避免出现在进程参数与进程列表中。
- `--output-schema` 约束最终 JSON；应用层仍必须再次做 schema 校验、枚举校验、置信度阈值和来源 ID 交叉验证。
- `--ignore-user-config` 避免服务器个人配置改变模型行为；认证仍由专用 `CODEX_HOME` 提供。
- 不传 `OPENAI_API_KEY`，启动时执行 `codex login status` 并要求结果明确为 ChatGPT 登录；未登录或认证方式不符时进入 `CODEX_AUTH_REQUIRED`，不 fallback。
- read-only sandbox 只是防线之一。生产进程还应使用专用低权限 Linux 用户、隔离且不可写的工作目录、无业务仓库挂载、无生产凭据、最小环境变量和调用超时。这样即使模型尝试工具调用，也没有业务资产可修改。

## 4. 最小架构

```text
Feishu Webhook
    │ HTTPS
    ▼
Fastify ingress
  验签/解密 → chat allowlist → event_id 幂等落库 → 立即 2xx
    │
    ▼
SQLite durable jobs
  按 chat_id + root/thread key 合并，默认 300 秒
    │
    ▼
Batch worker
  拉取必要上下文 → codex exec(read-only) → JSON 校验
    │
    ├─ 事实/决策/风险/现有任务更新（均保留 source_message_ids）
    ├─ 低置信度 → 澄清问题
    └─ 新任务 → Task Pack(PENDING_REVIEW) → 飞书审批卡片
                                                    │
                                                    ▼
                                     card.action.trigger
                                     身份校验 + 状态机 + 审计
```

历史回填是独立管线：

```text
白名单 chat_id
  → 分页读取群根消息
  → 发现 thread_id 后分页读取话题回复
  → 解析消息类型、附件 key、飞书文档链接
  → 下载/读取授权可见内容
  → 原始层去重持久化
  → 按时间与话题分批交给 Codex 只读整理
  → 生成带来源的事实、决策、风险、任务历史与未决问题
  → 保存回填游标、覆盖率和缺口报告
```

为什么不用内存定时器：服务重启会丢失 5 分钟窗口和重试状态。将 `not_before`、锁租约、attempt 与幂等键放入 SQLite，可在不引入 Redis 的前提下保证重启恢复。

为什么默认 SQLite：单机内部 MVP 的写入量低，SQLite + WAL + 持久化磁盘最少运维。只有腾讯云已存在合规、可复用的 PostgreSQL 时才切换，避免为 MVP 新建数据库服务。

## 5. 数据与状态设计

建议最少包含以下表：

- `feishu_events`：`event_id` 唯一，保存接收状态、哈希、时间、错误摘要。
- `source_messages`：`message_id` 唯一，保存 chat/thread 标识、发送时间、最小必要正文与来源信息。
- `batch_jobs`：合并键、`not_before`、状态、租约、attempt、最后错误。
- `codex_runs`：批次 ID、CLI 版本、schema 版本、耗时、结果、错误码；不保存认证信息。
- `project_facts`：事实内容、确认状态、来源消息 ID、首次/最近出现时间。
- `task_packs`：Task ID、结构化任务内容、版本、状态、创建来源。
- `approval_actions`：动作、操作者 ID、时间、前后状态、允许/拒绝原因。
- `outbox`：待发送飞书消息的幂等 outbox，确保重试不重复发卡片。
- `sync_cursors`：群/话题的回填游标、最早/最晚可见时间、同步状态与恢复点。
- `message_resources`：附件 key、类型、大小、哈希、持久化位置、来源消息和下载状态。
- `document_references`：消息中引用的飞书文档 token/type、读取权限、版本与抽取状态。
- `sync_gaps`：删除、权限拒绝、保密模式、超限、类型不支持等缺口及对应来源。

关键唯一约束：`event_id`、`message_id`、候选任务的 `source_batch_id`、审批动作的 `event_id`、outbox 的业务幂等键。

任务状态机：

```text
PENDING_REVIEW → APPROVED
               → CHANGES_REQUESTED → PENDING_REVIEW（新版本）
               → REJECTED
               → ARCHIVED
```

`DRAFT` 仅用于未发布草稿，不允许从 `APPROVED` 自动进入任何执行状态。数据库与代码中都不定义“执行任务”副作用。

## 6. 消息上下文与数据最小化

- 入口先按 `chat_id` 白名单过滤，非白名单消息不拉取上下文、不调用 Codex，仅记录最小拒绝审计。
- 合并键优先使用回复根消息/线程 ID；没有线程则使用 `chat_id`。
- 仅对白名单群执行完整历史回填；实时阶段只拉取当前批次需要的回复链和有限邻近上下文，不重复扫描整个群历史。
- 正文日志只记长度、哈希、消息 ID 和分类结果；完整正文只存数据库必要字段，并制定保留期。
- prompt 明确区分“原文”“推断”“已确认事实”；模型输出的事实默认带来源，无法追溯的条目拒绝入库。
- 飞书项目记忆不是单次大摘要：先保留不可变原始层，再构建可版本化的事实层。Ivy 后续在 Codex 中补充的电话、微信和邮件信息，必须标记为 `manual_ivy` 来源，不能伪装成飞书事实。

## 6.2 媒体处理策略

- 视频消息和视频文件：不下载、不解析，只保存消息 ID、发送时间、发送者、文件名/类型等可见元数据，并标记 `SKIPPED_BY_MEDIA_POLICY`。
- 普通音频文件（例如作为文件上传的 MP3/WAV）：不下载、不解析，按相同策略记录。
- 飞书原生语音消息（`msg_type=audio`）：下载消息资源并调用飞书官方语音识别 API转写；MVP只处理官方接口适用的 60 秒以内语音。
- 语音转写需额外申请飞书“语音识别”权限。转写结果保存来源 `message_id`、文本、状态和失败原因；不使用 OpenAI API Key。
- 原始语音仅作为临时处理输入，成功转写后不长期保留；超过 60 秒、权限不足、格式不支持或识别失败时写入 `sync_gaps`，不在 MVP 中引入本地 Whisper 运行栈。
- 飞书官方 ASR 文档未列独立按次价格，但调用受租户套餐、AI/API 权益和特殊频控影响。历史回填默认只统计语音数量，批量转写开关默认关闭，待 Ivy 在费用中心确认权益后开启。

## 6.1 “全部历史”的可验证定义

系统承诺同步“飞书 API 对该应用授权且可见的全部内容”，并输出覆盖率，不承诺绕过平台权限：

- 若机器人加入群后群设置禁止新成员查看历史消息，加入前内容可能不可见。
- 已删除消息只能记录删除状态，无法恢复正文或资源。
- 聊天资源接口只支持 100 MB 以内文件；不支持保密消息、合并转发子消息、部分卡片资源和某些外部群资源。
- 在线飞书文档需要文档自身权限与对应只读 scope；无权限时记录 token、来源和 403，不尝试绕过。
- 每次回填完成生成：消息总数、话题数、各类型资源数、最早/最晚时间、成功数、跳过数、失败数和逐项缺口原因。

## 7. Phase 1 实施顺序

1. 建立 TypeScript + Fastify 骨架、配置校验、结构化日志与健康检查。
2. 建立 SQLite migration、幂等事件表、durable batch jobs 和 outbox。
3. 实现历史回填器：群消息分页、话题二次分页、断点续传、限流、附件和文档引用索引、覆盖率报告。
4. 用飞书官方 SDK 实现 URL verification、事件/卡片回调验证、白名单与快速响应。
5. 实现 5 分钟合并器、重启恢复、锁租约和有限重试。
6. 实现 Codex adapter：认证 Gate、stdin、read-only、ephemeral、schema、超时、错误映射。
7. 实现分层项目记忆、分类结果验证、事实溯源、Task Pack 生成门槛与澄清路径。
8. 实现卡片发送、Ivy-only 审批、状态机与审计。
9. 完成确定性测试、固定 AI 样例、凭据泄漏测试、重启持久化测试。
10. 补齐 Docker Compose、数据卷、日志轮转、备份恢复、更新与回滚文档。

Phase 1 全程使用本地 fixture 和 mock 飞书客户端；在测试通过前不配置真实飞书回调。

## 8. 验收策略

- 单元测试：分类门槛、状态机、白名单、幂等键、合并键、日志脱敏、schema 校验。
- 集成测试：SQLite 重启恢复、重复事件、worker 失败重试、outbox 重发、Codex 超时/未登录。
- 合约测试：固定的飞书事件与卡片回调 JSON，不调用真实飞书。
- Codex adapter 测试：fake executable 输出成功、非法 JSON、超时、非零退出、认证缺失。
- AI golden cases：状态、新需求、低置信度、混合讨论、猜测、来源缺失；允许措辞变化，只断言结构与安全不变量。
- 安全不变量：测试中放置 canary 文件，审批前后断言文件未变化、没有部署命令、没有外部发送副作用。

## 9. Phase 2 只读服务器 Preflight 清单

取得服务器访问后，仅执行读取命令并形成报告：

- OS/架构、CPU、内存、磁盘、时区与时间同步。
- `docker`、`docker compose`、`node`、`git`、`codex` 路径和版本。
- `codex login status` 的认证方式；不读取认证文件内容。
- 监听端口、容器、systemd 服务、反向代理配置位置；不重启或修改。
- 域名 DNS、HTTPS 证书有效期、公网 443 可达性。
- 数据目录候选位置、权限、容量、备份目标。
- 出站访问 `open.feishu.cn` 与 Codex 所需服务的条件。

任何缺失项只输出最小补充清单，不自动安装或修改。

## 10. Ivy 需要提供或亲自完成的操作

进入 Phase 1 前：

- 确认允许开始创建本地 MVP 源码与测试。
- 首个测试群 `chat_id` 已提供。仍需 Ivy 用于审批的真实用户 `open_id`（通常为 `ou_...`）；可从卡片回调的 `operator.open_id` 或通讯录接口验证。
- 确认该群是否允许新加入的机器人查看历史消息，以及是否包含话题模式。

进入 Phase 2 前：

- 提供腾讯云新加坡服务器的只读 SSH 访问方式，或由 Ivy 运行我们提供的 Preflight 脚本并回传脱敏结果。
- 提供目标域名、DNS 管理责任人与现有反向代理信息。
- 说明凭据将存放在哪个服务器 Secret 位置；不要在聊天中发送值。

进入 Phase 3 时由 Ivy 亲自完成：

- 创建/授权飞书企业自建应用，配置最小权限、测试群、事件与卡片回调。
- 将 App ID、App Secret、Verification Token、Encrypt Key 写入服务器 Secret；不粘贴到代码或聊天。
- 提供白名单群 ID、审批群 ID、Ivy 稳定用户 ID（这些是标识符，不是登录凭据）。
- 在服务器终端运行 Codex 交互式 ChatGPT 登录，并用 `codex login status` 确认；不分享密码、Cookie、Token 或认证文件。

## 11. 当前 Gates

- `GATE_PHASE_1_APPROVAL`：已完成；当前等待书面 spec 复核后进入 TDD 实现。
- `GATE_MESSAGE_SCOPE`：已完成，范围为白名单群全部可见历史消息、话题与文件。
- `GATE_HISTORY_VISIBILITY`：确认机器人加入后可查看群历史；否则记录可见性缺口。
- `GATE_APPROVER_ID`：Ivy 当前提供的是 `oc_...` 候选值，疑似群 ID；验证出真实用户 `open_id` 前审批功能保持关闭。
- `GATE_SERVER_ACCESS`：只读 Preflight 已通过 `aijia-tencent` 完成；部署变更权限仍未开放。
- `GATE_FEISHU_APP`：Phase 3 前完成应用与最小权限配置。
- `GATE_CODEX_AUTH`：Phase 3 由 Ivy 在服务器交互式登录。

## 12. 已知限制

- Phase 0 没有目标服务器访问，因此不能判断腾讯云环境是否可部署。
- 飞书权限名称和后台配置可能随平台更新，Phase 3 前需再次按官方页面核对。
- Codex CLI 当前本机版本是 alpha；Phase 1/2 需验证目标版本的 flags 和 JSON 行为并固定版本。
- AI 分类不是确定性规则；最终安全依赖应用层门槛、状态机和“无执行路径”的架构，而不是依赖 prompt 承诺。
- 项目记忆第一阶段只覆盖飞书与 Ivy 手工补充的外部沟通结果；不会自动读取微信、电话或邮件。
