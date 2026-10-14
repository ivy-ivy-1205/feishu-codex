# Founder 白板入口可见性修复变更单

状态：**本地候选完成，等待 Ivy 批准生产部署**。

目标提交：`c99c1325dc8edd64cfff07ff3b89c5cdcb7529ef`。

tracked-only 归档：

- `/tmp/feishu-whiteboard-entry-c99c132.tar`：2,498,560 bytes，SHA-256 `613dad39cc6b2d00046ec73a2cbb3940d2c0c21528715fdd206f7763f03e68be`
- `/tmp/feishu-whiteboard-entry-c99c132.tar.xz`：439,896 bytes，SHA-256 `c29393d0df4a552594769d0e21ce6d19c670dfb995709b459463e0a679f3af20`

## 1. 用户问题与根因

Ivy 在批准群输入 `查看工作地图` 后收到了两页完整文本卡。白板实际创建成功，第 1 页底部存在“打开可编辑看板”按钮；但按钮位于超长全文之后，第 2 页截图中也没有可感知的白板说明。对用户而言，首屏看不到入口，就等同于“没有看板信息”。

根因位于 `withWhiteboardLink`：它使用 `elements.push(...)`，把按钮固定追加到每张卡全部正文和处理状态之后。问题不在飞书权限、白板节点 schema、白板创建或群编辑授权。

## 2. 修复行为

每一页群卡的前两项固定为：

1. `可编辑看板已生成`，说明当前查询的完整内容已经同步到飞书白板，并显示本次随机配色名称；
2. `打开可编辑看板` 主按钮。

完整文本继续原样保留在入口之后。若卡片投递重试，已有入口会被移动到首屏且不重复；白板创建失败时仍走现有可见降级，不伪造成功入口。

现有已投递消息不会被编辑。部署后 Ivy 或 James 需要重新发送查询命令，才能看到新卡片。

## 3. 本地验证

- TDD 红灯证明旧实现的第一个元素仍是“整理范围”，入口位于末尾。
- 绿灯覆盖 13 个项目生成两页工作地图，并断言两页首屏都有成功说明、`Coral` 配色名和同一个白板 URL。
- 完整门禁：96 个测试文件、819 项测试通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。

## 4. 生产差异

只替换 Bridge 应用镜像与 app 目录。没有数据库 schema 或业务数据变更，没有 env、飞书权限、应用版本、群范围、定时任务、模型配置或 API Key 变更；`FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false` 必须保持。

## 5. 执行步骤

### H1：只读门

- 核对当前生产仍运行 `3b19b2d`、running/healthy、restart 0、health/ready 200。
- 核对 SQLite 完整性、active jobs、pending outbox、两位 Founder 身份和磁盘；不打印凭据或业务正文。

### H2：隔离候选

- 上传压缩归档并双重校验 SHA-256；解压到独立 build 目录。
- 构建候选镜像，OCI revision 必须精确等于目标提交；运行完整配置解析与编译产物检查，不挂载生产 SQLite、不调用飞书、不发送消息。

### H3：停止态备份与一次切换

- active Founder jobs=0 后停止 Bridge。
- 创建 SQLite 一致性备份并校验 mode 600、`integrity_check=ok`；备份当前 app 和运行镜像。
- 提升候选 app／镜像并启动 Bridge 一次，不做试探性第二次重启。

### H4：验收与清理

- 核对 running/healthy、restart 0、health/ready 200、目标 OCI revision、ChatGPT 登录、无 API Key fallback、SQLite 完整、Founder 身份各 1、active jobs=0、pending outbox=0。
- 核对 whiteboard=true、group-delivery=false 和唯一批准群不变。
- 不由部署脚本主动调用查询或发送群消息；删除上传归档、隔离 build 和无引用候选标签，保留运行镜像及回滚资产。

## 6. 真实验收

部署通过后，由 Ivy 或 James 在唯一批准群重新发送 `查看工作地图`。预期每一页卡片标题下方立即显示“可编辑看板已生成”、本次配色名和打开按钮；打开后仍是包含完整文本的原生可编辑白板。

随后可用 `查看项目进展：项目名`、`查看分歧：项目名` 验证另外两种查询使用同样的首屏入口。

## 7. 异常与回滚

候选 revision、配置门、数据库、健康检查或身份映射任一异常即停止。切换后异常时保留现场，不自动第二次重启；恢复旧 app／镜像或数据库需要按异常点执行既定回滚并记录。白板文档是外部对象，不随代码回滚删除。

## 8. 审批范围

批准本单即授权 H1–H4：生产只读核验、候选上传／隔离构建、停止态备份、一次 Bridge 切换、验证和临时资产清理。

不包含主动发送群消息、替 Ivy/James 调用查询、第二次重启、数据库恢复、权限／env 修改、扩大群范围或删除已有白板文档。
