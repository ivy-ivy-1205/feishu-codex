# Founder 三类查询原生飞书白板上线变更单

状态：**Ivy 已批准；2026-10-13 执行至 D2 权限探针失败后按停止条件暂停**。

2026-10-14 补充：带安全阶段诊断的第二次获批探针在 `create_document` 返回飞书码 `99991672`；D3/D4 继续暂停。后续权限变更见 [`2026-10-14-founder-whiteboard-permission-change-sheet.md`](./2026-10-14-founder-whiteboard-permission-change-sheet.md)。

目标提交：`d853f5c537cbb3b0d68b25bc51fe94eb2293e9f5`。

tracked-only 发布归档：`/tmp/feishu-founder-whiteboard-d853f5c.tar`，大小 `2457600` bytes，SHA-256 `7538734e7f2c47005b1d3eacb7c44d72238d5055cc06da0506f823aabf11ef89`。

生产当前代码基线：`25b2269306e72e5cc212da3a5de22891d9027f7f`。2026-10-13 只读核验时 Bridge 为 healthy/ready，Ivy 与 James 身份各 1 条，capture/analysis/manual-query/daily-reconciliation=true，group-delivery=false。

## 1. 本次结果

机器人继续支持 `查看工作地图`、`查看对齐：项目名`、`查看待对齐`，并新增：

- `查看项目进展：项目名`：显示当前阶段、明确完成记录、待推进事项和卡点／依赖；没有明确完成证据时不把共识或项目状态冒充完成。
- `查看分歧：项目名`：并列展示双方理解、已有共识和待决定问题；`查看分歧` 等价于全局待对齐总览。
- 三类查询均把原卡全部文字写入一个原生飞书白板文档，节点可编辑，不使用截图；从 Ivy 选定的 25 套配色中随机选择，并避开上一张配色。
- 群卡保留完整文本，并增加“打开可编辑看板”按钮。文档授予调用群编辑权限。
- 白板 API 失败时发送完整文本卡并显示“看板生成失败”；失败状态持久化，避免投递重试重复创建文档。
- 仅已配置 Founder 可调用，因此现有 James 身份可直接测试。

本次不启用自动群提醒或自动工作地图推送，不执行 Todo，不修改 topic／观点／共识，不增加 OpenAI API Key 或其他模型通道。

## 2. 语料覆盖证据与上线回填

生产上一次完整 daily coverage 截止 `2026-10-13T08:44:14.981Z`（北京时间 16:44:14），最近可见群消息时间为 `2026-10-13T07:34:36.119Z`（北京时间 15:34:36）。

已对 `2026-10-13T08:44:14.981Z` 至 `2026-10-13T12:54:22.000Z`（北京时间 20:54:22）执行真实飞书 dry-run：根分页 1 页、`next_cursor_null`、读取 0 条新消息、0 个 gap。该证据证明 20:54:22 前没有未回填的新消息，但 dry-run 本身不写数据库。

上线时执行两段持久化回填：

1. 切换前把 `08:44:14.981Z → 12:54:22.000Z` 以 `--persist` 落为完整 coverage；预期 0 个新 source、0 个分析 job。
2. 候选服务启动后立即冻结服务器当前 UTC 为 `T1`，把 `12:54:22.000Z → T1` 以 `--persist` 补齐；日志记录精确 `T1`、分页终止、消息数、gap 和 job 数。若有新来源，等待对应 Founder job 完成后再开放 James 测试。

只有 `next_cursor_null` 才接受为完整覆盖。读取失败、分页异常或新 job 失败时停止验收，不把范围表述为已同步。

## 3. 精确配置差异

生产 `bridge.env` 只新增：

```text
FOUNDER_STREAM_WHITEBOARD_ENABLED=true
```

下列现有边界必须保持：

```text
WORKER_ENABLED=true
FOUNDER_STREAM_CAPTURE_ENABLED=true
FOUNDER_STREAM_ANALYSIS_ENABLED=true
FOUNDER_STREAM_MANUAL_QUERY_ENABLED=true
FOUNDER_STREAM_DAILY_RECONCILIATION_ENABLED=true
FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false
PROJECT_CONTEXT_CHAT_IDS=oc_a84d5b6ca478220d0a37964b50776edb
```

配置校验要求 whiteboard 只能在 manual-query 已启用时开启。没有数据库 schema 变更。

## 4. 本地门禁

- `96` 个测试文件、`816` 项测试全部通过。
- `pnpm typecheck`、`pnpm build`、`git diff --check` 全部通过。
- 覆盖命令解析、James 身份调用、项目进展四栏语义、25 配色不连续重复、原卡文字不丢失、原生节点无图片、SDK 文档／白板／权限调用、节点 50 个一批、错误码 fail-closed、群编辑授权、投递重试不重复建板、白板失败可见降级和显式生产权限探针。

## 5. 执行步骤

### D1：最终只读确认

- 核对运行容器 image ID、revision、startedAt、restart count、health、ready。
- 核对 SQLite `integrity_check`、active jobs、pending outbox、Founder 身份计数和最近完整 coverage。
- 核对生产配置边界和磁盘空间，不打印任何 secret 值。
- 任一状态异常即停止，不构建、不写库、不重启。

### D2：隔离构建与应用权限探针

- 上传并再次校验本单指定归档 SHA-256；在隔离目录构建 OCI revision 为目标提交的候选镜像。
- 临时容器不得挂载生产 SQLite；先执行配置解析与编译产物检查。
- 使用候选镜像和现有机器人应用身份，显式运行 `preflight-founder-whiteboard --create`，只在唯一批准群创建一份标题为“AiJia 机器人白板权限核验”的无业务数据文档，写入原生节点并授予该群编辑权限；不发送群消息。
- 探针输出只保留 document ID、whiteboard ID、链接和 palette ID。任一步权限失败即停止，不修改生产服务；若已部分创建文档，记录其 ID，不重复盲试。

### D3：切换前覆盖落库与备份

- 执行第 2 节第一段固定窗口 `--persist`，核验 `next_cursor_null` 且无 gap。
- 等待 active Founder jobs=0，再停止 Bridge。
- 备份 SQLite、env、当前 app 目录和回滚镜像；SQLite 备份 mode 600，`integrity_check=ok`。
- 写入唯一新配置值，再次确认 group-delivery=false。

### D4：一次服务切换与补窗口

- 用候选镜像和目标 app 目录启动 Bridge 一次；不做试探性第二次重启。
- 核对 running/healthy、restart count、health/ready、OCI revision、ChatGPT 登录、无 API Key fallback、SQLite 完整性和两位 Founder 身份。
- 冻结并记录 `T1`，执行第 2 节第二段持久化回填；有新 job 时等待终态并核验失败数。
- 核对自动 group-delivery 仍关闭、没有非预期群消息；不由部署脚本主动调用三条查询。

### D5：真实验收

由 James 在批准群发送 `查看工作地图`。预期机器人返回完整文本卡和一个可编辑白板入口，处理状态里的最后防漏复核截止 `T1`。随后可测试 `查看项目进展：项目名` 与 `查看分歧：项目名`；每次生成的颜色来自 25 套收藏，且不与上一张重复。

## 6. 异常与回滚

以下任一情况先停止并保留现场，不自动恢复数据库：

- 白板权限探针失败或群编辑授权失败；
- 回填没有以 `next_cursor_null` 结束、出现权限 gap 或读取了非批准群；
- health/ready、SQLite 完整性、身份映射或 ChatGPT 登录异常；
- active jobs 持续增长、出现新的未补偿失败或自动群投递被开启；
- James 查询没有完整文字、没有白板链接，或同一次投递重试重复创建白板。

代码／配置回滚恢复旧 app checkpoint、旧 env 和旧镜像。本次无 schema migration，正常不恢复数据库；只有确认产生不可接受的数据写入且 Ivy 单独批准后，才使用一致性备份恢复数据库。白板权限探针已经创建的飞书文档不随代码回滚自动删除，需保留链接并单独处理。

## 7. 清理与审批范围

验证成功后删除本次上传归档、隔离 build 目录和无容器引用的候选标签；保留运行镜像、回滚镜像、SQLite 备份、env/app checkpoint、审计日志和权限探针文档链接。

Ivy 批准本变更单即授权 D1–D4 及成功后的上述临时资产清理。审批包含：一次无业务数据飞书白板权限探针、两个明确窗口的唯一批准群历史回填、一个生产配置键、一次 Bridge 切换。权限后台修改、第二次重启、数据库恢复、主动发送群消息、自动群投递或扩大群范围均不在本次授权内。

## 8. 2026-10-13 执行记录

- D1 通过：生产 revision 仍为 `25b2269306e72e5cc212da3a5de22891d9027f7f`，Bridge running/healthy、restart=0，`/health` 与 `/ready` 成功，SQLite 与配置边界正常。
- 指定归档上传后双重校验通过：压缩传输文件 SHA-256 为 `ac35e00bd1bfcfd921b8acf5922bc071de44f20e442c6898779284530a0403d5`；解压后的原始 tar 为 `2457600` bytes，SHA-256 与本单指定值一致。
- 隔离候选镜像构建完成，OCI revision 为目标提交；候选配置解析与编译产物检查通过，未挂载生产 SQLite。
- 唯一一次 `preflight-founder-whiteboard --create` 返回失败；CLI 为防止泄露只输出通用权限错误，未返回 document ID 或 whiteboard ID，因此不能证明是否产生了部分文档。按本单停止条件没有重试创建，也没有进入 D3/D4。
- 停止后复核：生产 Bridge 仍是旧 revision、原 startedAt 和 restart=0；`FOUNDER_STREAM_WHITEBOARD_ENABLED` 未写入，`FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false`；没有回填、停服、重启、镜像切换或主动群消息。
- 失败现场保留在服务器的本次上传、隔离 build、候选镜像与构建日志中。下一步需要单独批准飞书开发者后台权限核对／修改及一次新的无业务数据探针；在此之前不得开启白板功能。

## 9. 2026-10-14 安全诊断与第二次探针

- 新增诊断提交 `bd5ebe4a941017155cecab6c859ce4dc6a99a36c`，失败输出严格限制为阶段名与飞书数字错误码，不打印远端消息、响应正文或凭据。
- 完整本地门禁为 96 个测试文件、817 项测试通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过。
- 新归档 `/tmp/feishu-whiteboard-diagnostic-bd5ebe4.tar` 为 `2467840` bytes，SHA-256 `6ad95e96d9a80dcb8a704871951d43e60ed9021f173cc46c5dc89d254924e0b2`；压缩包 SHA-256 `c9b47e5bb1fa4deedf81d1198a1c5b8500f7f7c679c65258764fe2d81b650de2`。服务器双重校验一致。
- 服务器隔离构建得到 `aijia/feishu-codex-bridge:diagnostic-bd5ebe4`，OCI revision 与提交精确一致；配置解析和诊断产物检查通过，未挂载生产 SQLite。
- 恰好一次获批的第二次探针返回 `{"status":"failed","stage":"create_document","feishuCode":99991672}`，退出码为 1。失败发生在第一个创建文档 API，因此本次没有创建飞书文档，后续三个阶段没有执行。
- 本次未执行 D3/D4，没有回填、停服、重启、env／数据库修改、镜像切换或群消息。生产仍运行 `25b2269306e72e5cc212da3a5de22891d9027f7f`、healthy、restart=0、group delivery=false。
- 下一步只允许按 2026-10-14 权限变更单核对并增加最小应用身份权限；该外部变更和新的探针需要独立批准。

## 10. 2026-10-14 权限变更与第三次探针

- 权限变更单 P1/P2 已完成：生产 `Codex` 应用只新增并自动发布 `docx:document:create`、`docx:document:write_only`、`board:whiteboard:node:create`、`docs:permission.member:create` 四项应用身份权限，均为免审且显示已开通。
- P3 恰好运行一次无业务数据探针，返回 `{"status":"failed","stage":"create_nodes","feishuCode":2890002}`。这证明创建文档和插入空白画板已经成功；节点写入失败，群编辑授权未执行，群内未发送消息。
- 探针 CLI 没有保留后续失败前取得的 document ID / whiteboard ID，因此无法定位本次孤立探针文档；没有重试或删除。
- 飞书官方白板流程建议使用 `@larksuite/whiteboard-cli` 生成 OpenAPI 节点并明确不推荐手写 raw JSON；现有候选实现手写节点参数，离线对比已发现与官方生成格式的差异。下一步先在本地修正并重新完成隔离门禁，再申请一次新的探针。
- D3/D4 继续未执行。停止后生产仍为 revision `25b2269`、running/healthy、restart=0，原 startedAt 未变；白板开关不存在、group delivery=false，health/ready=200；未回填、未改 env／数据库、未重启或发群消息。
