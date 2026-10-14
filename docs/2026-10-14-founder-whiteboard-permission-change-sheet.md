# Founder 白板最小权限变更单

状态：**待 Ivy 批准；尚未修改飞书开发者后台**。

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
