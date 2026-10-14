# Founder 白板最小权限变更单

状态：**Ivy 已批准并执行 P1–P3；原探针在 `create_nodes` 停止，随后经独立批准完成 schema 修复与一次新探针，新探针已通过；生产仍未部署或重启**。

目标应用：生产 `AiJia Context` / `Codex` 企业自建应用，App ID `cli_aad1fef1c7b81bda`。操作账号为 `sharon`。

目标：只补齐 Founder 三类查询创建原生飞书白板所需的应用身份权限，并运行一次无业务数据探针。此次不部署 Bridge、不重启服务、不修改生产配置或数据库、不回填语料、不发送群消息。

## 1. 已确认的断点

2026-10-14 使用诊断提交 `bd5ebe4a941017155cecab6c859ce4dc6a99a36c` 运行了唯一一次获批的无业务数据探针，安全输出为：

```json
{"status":"failed","stage":"create_document","feishuCode":99991672}
```

`99991672` 表示应用未开通调用所需的 API 权限。失败发生在第一个 `docx.v1.document.create` 请求，因此本次探针没有创建文档，后续创建白板块、写白板节点和授予群编辑权限均未执行。

该结果同时排除以下方向为当前首要原因：SSH、候选镜像构建、生产数据库挂载、群消息投递和 Bridge 运行状态。生产仍运行 `25b2269306e72e5cc212da3a5de22891d9027f7f`，白板功能开关未写入。

## 2. 最小权限清单

在飞书开发者后台的“权限管理”中，以**应用身份**增加下列权限；只添加当前未开通的项：

| 技术权限码 | 用途 | 对应代码阶段 | 当前证据 |
| --- | --- | --- | --- |
| `docx:document:create` | 创建承载白板的飞书文档 | `create_document` | **本次已证实断点**：第一个创建文档请求返回 `99991672` |
| `docx:document:write_only` | 在文档中新增白板 block | `create_board` | 调用链必需；本次因前一步失败尚未到达 |
| `board:whiteboard:node:create` | 向白板写入原生可编辑节点 | `create_nodes` | 调用链必需；本次尚未到达 |
| `docs:permission.member:create` | 将唯一批准群添加为文档编辑者 | `grant_group_edit` | 调用链必需；本次尚未到达 |

不申请 `docx:document`、`board:whiteboard`、`drive:drive` 等更宽权限；当前功能不读取文档或白板内容，也不需要新增读取权限。

官方依据：

- 飞书官方 CLI 的文档创建实现声明 `docx:document:create`，写入文档块声明 `docx:document:write_only`：<https://github.com/larksuite/cli/blob/main/shortcuts/doc/docs_create.go>
- 飞书官方 CLI 的白板节点更新实现声明 `board:whiteboard:node:create`：<https://github.com/larksuite/cli/blob/main/shortcuts/whiteboard/whiteboard_update.go>
- 飞书官方示例为添加文档协作者声明 `docs:permission.member:create`：<https://github.com/larksuite/lark-samples/blob/main/mcp_larkbot_demo/nodejs/README.md>
- 飞书通用错误码文档：<https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code>

## 3. 执行步骤

### P1：后台只读核对

1. 使用 `sharon` 打开 App ID `cli_aad1fef1c7b81bda`，再次核对不是另一个 `codex feishu CLI` 应用。
2. 记录上述 4 个权限的当前状态，仅记录权限码与状态，不记录凭据。
3. 核对后台是否已有其他未发布的权限或版本草稿。若存在与本单无关的待发布修改，立即停止，避免将它们捆绑发布。

### P2：增加并发布最小权限

1. 只勾选上述清单中缺失的权限，身份类型必须为应用身份。
2. 若后台显示修改自动生效，记录生效状态；若要求创建并发布应用版本，只发布包含本单 4 项权限差异的版本。
3. 若任一权限需要管理员审批、敏感权限审批或扩大可用范围，停止并报告，不绕过审批。
4. 发布后重新读取权限页，确认目标 4 项均为已开通／已发布，且没有额外权限被加入。

### P3：一次无业务数据探针

使用已构建的诊断候选镜像 `aijia/feishu-codex-bridge:diagnostic-bd5ebe4` 运行一次：

```text
preflight-founder-whiteboard --chat-id <唯一批准群> --create
```

探针只创建标题为“AiJia 机器人白板权限核验”的文档，写入一句无业务数据说明，创建原生节点并授予唯一批准群编辑权限；不挂载生产 SQLite、不发送群消息。

成功时记录 document ID、whiteboard ID、文档链接和 palette ID。失败时只记录 `stage` 与飞书数字错误码，立即停止，不重试；若失败发生在 `create_board`、`create_nodes` 或 `grant_group_edit`，记录已创建的探针文档，避免再次产生孤立文档。

### P4：停止点

权限和探针成功后仍不进入原上线单 D3/D4。先确认探针文档可由群成员编辑，再单独更新目标部署提交并获得 Bridge 切换授权。

## 4. 验收标准

- 权限页只新增本单列出的缺失权限，没有额外 scope。
- 探针完整通过四个阶段：`create_document`、`create_board`、`create_nodes`、`grant_group_edit`。
- 返回的文档可打开，包含原生可编辑节点；唯一批准群获得编辑权限。
- 生产 Bridge revision、startedAt、restart count、数据库、env 与群投递状态均不变。
- 没有发送机器人群消息，没有读写业务语料。

## 5. 异常与回滚

- 后台出现无关待发布差异、管理员审批、权限范围不明确或应用身份不匹配：停止，不发布。
- 探针失败：保留 stage、数字错误码和已生成文档 ID；不做第二次探针，不修改生产。
- 若权限变更本身需要撤回，另行批准后只移除本单新增的权限并发布新版本；不自动撤回，避免影响审计和误伤现有消息能力。
- 探针文档属于外部飞书对象，不自动删除；如需删除，记录链接并单独授权。

## 6. 本次审批范围

批准本变更单即授权：在生产 App ID `cli_aad1fef1c7b81bda` 中增加上述 4 项里当前缺失的应用身份权限；在没有无关草稿且无需额外管理员审批的前提下发布；随后运行**恰好一次**无业务数据探针。

不包含：Bridge 部署或重启、生产 env／SQLite 修改、历史回填、主动群消息、自动群投递、扩大群范围、删除探针文档、第二次探针或额外权限。

## 7. 2026-10-14 执行记录

### P1：后台核对通过

- 账号与应用匹配：`sharon`、正式应用 `Codex`、App ID `cli_aad1fef1c7b81bda`。
- 执行前上述 4 项权限均未开通；后台显示“当前修改均已发布”，没有与本单无关的待发布权限或版本草稿。

### P2：最小权限已开通并发布

- 仅新增 `docx:document:create`、`docx:document:write_only`、`board:whiteboard:node:create`、`docs:permission.member:create` 四项应用身份权限。
- 后台逐项显示“免审权限”；确认后四项均显示“已开通”，应用页继续显示“当前修改均已发布”。没有加入额外 scope，也没有触发管理员审批或扩大可用范围。

### P3：唯一一次探针已运行并停止

探针精确返回：

```json
{"status":"failed","stage":"create_nodes","feishuCode":2890002}
```

该结果证明 `create_document` 与 `create_board` 已通过：本次创建了一份标题为“AiJia 机器人白板权限核验”的文档和其中的空白画板。失败发生在第一批原生节点写入，因此没有进入 `grant_group_edit`，唯一批准群没有获得该探针文档的编辑权限，机器人也没有向群内发送消息。

诊断 CLI 在后续阶段失败时没有输出已取得的 document ID / whiteboard ID，所以当前无法定位该孤立探针文档的链接；不运行第二次探针来补取 ID，也不未经授权删除外部对象。

飞书开发者后台在同一时间窗口只检索到 tenant access token 日志，尚未返回文档／画板／节点三次 API 明细。离线核对得到的最窄结论是：权限门已经越过，现有 Bridge 手写的 OpenAPI raw 节点参数不被服务端接受。飞书官方白板流程明确要求复杂画板先由 `@larksuite/whiteboard-cli` 生成 OpenAPI 节点，并提示不要直接创作 raw JSON；本机缓存的官方 CLI `0.2.11` 生成的文本节点不带现有实现使用的透明 `style.fill_color="#FFFFFF00"`，同时补齐颜色类型等规范字段。该差异是下一步的首要修复方向，但在新的真实探针通过前不把某个单独字段宣称为唯一根因。

官方依据：

- <https://github.com/larksuite/cli/blob/main/skills/lark-whiteboard/references/lark-whiteboard-update.md>
- <https://github.com/larksuite/cli/blob/main/skills/lark-whiteboard/references/lark-whiteboard-workflow.md>

### 停止后生产复核

- 生产 Bridge 仍运行 revision `25b2269306e72e5cc212da3a5de22891d9027f7f`，状态 `running/healthy`，restart count 为 `0`，startedAt 仍为 `2026-09-26T10:52:57.884143047Z`。
- 本机 `/health` 与 `/ready` 均返回 200；`FOUNDER_STREAM_WHITEBOARD_ENABLED` 仍不存在，`FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false`。
- 未部署或重启 Bridge，未修改生产 env／SQLite，未回填语料，未发送群消息，也未运行第二次探针。

### 当时的下一步审批边界（已完成）

当时要求独立批准：在本地把白板节点生成改为官方 CLI 可接受的 OpenAPI 结构，完成测试与隔离候选构建，然后只运行一次新的无业务数据探针。Ivy 后续已明确批准并完成该范围，结果见第 8 节；该批准不包含 Bridge 部署／重启、生产配置或数据库修改、历史回填和群消息。

## 8. Schema 修复与新探针执行记录

Ivy 已独立批准本地 schema 修复、隔离候选构建和一次新探针，明确不部署或重启 Bridge。

- TDD 红灯准确捕获现有文本节点携带 `style.fill_color="#FFFFFF00"`；该 8 位透明色和额外文本节点 `style` 不在官方 CLI 生成的文本节点格式中。
- 提交 `3b19b2de362c081f291bd573f647e01882e34fdd` 移除文本节点透明 `style`，并补齐官方输出中的 `line_through`、`underline`、`italic`、`angle`、颜色类型和主题颜色码；布局、卡片文字、矩形节点与 25 套配色逻辑未改。
- 本地完整门禁通过：96 个测试文件、818 项测试；`pnpm typecheck`、`pnpm build`、`git diff --check` 均成功。
- tracked-only 归档 `/tmp/feishu-whiteboard-schema-3b19b2d.tar` 为 2,488,320 bytes，SHA-256 `2b97d5a7ea6b6f57d00c3c8948f0e7a146d7cb94422f197d90db180f4fe3fd73`；压缩包为 437,304 bytes，SHA-256 `b3e836c2241c3110a3d7116fed609cf9d676adaf728d764d331875dc816b2262`。服务器端压缩包哈希一致。
- 隔离候选镜像为 `aijia/feishu-codex-bridge:diagnostic-3b19b2d`，image ID `sha256:e752cbf9ec652b9b92052df7e04140d2dc70ad0b87c326591b18a9fd0d325081`，OCI revision 与提交精确一致。编译产物确认不含旧 `#FFFFFF00`，包含新的规范字段。
- 恰好一次获批的新探针完整通过，返回 document ID `Q0bydHfIDom0zoxXBJKclBPWnKW`、whiteboard ID `FCltwXNXZhSc0XbDJ5hcdgxPnCe`、palette ID `grove`，文档链接为 <https://icnua99ny9c4.feishu.cn/docx/Q0bydHfIDom0zoxXBJKclBPWnKW>。返回发生在 `grant_group_edit` 成功之后，因此唯一批准群已经获得编辑权限；未发送群消息。
- 探针后生产仍运行 revision `25b2269306e72e5cc212da3a5de22891d9027f7f`，状态 `running/healthy`、restart 0、原 startedAt 不变；whiteboard flag 不存在、group delivery=false、health/ready=200。未部署、未重启、未修改 env/SQLite、未回填语料。

## 9. 飞书应用后续更新的影响

白板 schema 修复位于本仓库的 Bridge 代码，并打包在服务器 Docker 镜像中；它不是上传到飞书开发者后台的一段代码。飞书应用只提供固定 App ID 对应的身份、权限、机器人能力和事件配置，因此发布普通的名称、图标、描述或其他功能更新，不会覆盖本次 Bridge 代码。

后续更新飞书应用时需保留以下运行合同，否则对应能力会失效：

- 保留本单四项权限及现有消息／历史读取权限，发布后确认均为“已开通／已发布”；
- 不更换应用身份；若轮换 App Secret，先按单独变更单同步服务器凭据位置，再验证 token 获取；
- 保持生产机器人在唯一批准群内，并保留现有事件订阅、回调、安全设置和必要的 IP 白名单；
- 飞书升级白板 API 或 SDK 后，先用本变更单同类的无业务数据探针验证 schema，再更新生产 Bridge。

因此可以继续更新飞书应用；风险来自运行合同被改动，而不是“发布新版本”这个动作本身。
