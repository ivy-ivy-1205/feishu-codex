# Founder 白板版式一致性修复变更单

日期：2026-10-14
状态：D1–D3 已完成；生产运行 revision `f04442e4702d4d65de7bf2212798aa5d50bac95f`；等待 D4 唯一一次群内人工验收

## 问题与根因

群卡入口已经生效，`打开可编辑看板` 能打开飞书文档和原生白板。当前差距发生在白板节点生成阶段：

- 本地评审稿使用专门的工作地图版式，显式编排 A/B/C 主线、项目与子项目、任务、阶段目标、共用底座、待核对关系和历史区。
- 生产 `buildFounderWhiteboard` 没有复用该版式。它先把飞书卡片降为无语义的文本数组，再按高度轮流塞进两列；每段文字只得到同一种矩形和同一种字号。
- `BlockFrame` 只改变纸张、边框、填充和文字颜色，无法补回已经丢失的业务层级。
- 现有测试只检查“所有文字仍存在”和 OpenAPI schema 合法，没有检查 A/B/C 主线、父子层级、视觉层级或与已批准 demo 的结构一致性，因此该退化没有被门禁拦住。

这不是飞书白板的展示限制。2026-10-13 的静态试阅已经证明，同一个飞书原生白板能够承载接近 demo 的 89 个原生节点版式。

## 修复目标

同一份动态查询数据必须同时驱动：

1. 群内首屏预览，直接展示风格化总览图和必要的主线细节图；
2. 群内文字卡，负责完整文字与来源追溯；
3. 飞书白板，负责可缩放、可编辑和评论；
4. 本地验收预览，直接渲染将要发送给飞书的同一批节点，避免 HTML demo、群聊预览与生产白板再次走多套实现。

默认阅读路径必须在群聊内完成。`打开可编辑白板` 降为次要操作，只在需要编辑、评论或自由缩放时使用。

配色只作用于语义 token，例如纸张、主线标题、重点、风险和历史状态，不再把整张图的每个内容块涂成同一种高饱和底色。

## 本地完成结果

- 当前查询的结构化主题、父子关系、阶段、类型、目标、来源数量和覆盖缺口作为唯一输入，同时驱动飞书原生白板节点与群聊 PNG 总览；不再从最终文字卡反向猜布局。
- 工作地图已按 A/B/C 主线排版，单独表达子项目连接、任务、阶段目标、共用服务底座、待核对项目和已结束历史。
- 群聊总览固定生成 1160px PNG，使用飞书图片组件 `fit_horizontal` 放在第一页首项；完整文字仍留在原卡中，第二页不重复图片。
- `打开可编辑白板` 使用次要按钮。若图片上传成功但可编辑白板创建失败，群内总览仍会发送，并明确提示编辑暂不可用；若图片上传也失败，完整文字卡继续兜底。
- 随机配色继续限定在 Ivy 已选的 25 套中，并避免与上一次连续重复。
- 生产镜像增加 Noto CJK 字体，避免 Linux 容器生成中文方框。
- 同源本地预览：`docs/reviews/2026-10-14-founder-inline-workmap-preview.png`，1160×1847、约 110KB。
- 自动门禁：96 个测试文件、825 项测试全部通过；TypeScript typecheck、生产 build、`git diff --check` 全部通过。
- 代码候选提交为 `1c4719a`。
- 本机 Docker build stage 已完成应用编译、生产依赖裁剪和 Linux Sharp PNG 渲染；不含字体的 build stage 明确出现 Fontconfig 缺失和中文方框，证明字体不是可选美化。完整 runtime 镜像在 Docker 内 Debian 镜像源下载字体包时连续超时，未取得本地成功结果。生产候选构建必须把 Noto CJK 安装与中文 PNG 目检列为硬门禁，失败则不切换 Bridge。

## 已完成的本地步骤

### L1｜结构化输入与视图分流

- 白板 publisher 接收查询类型和结构化项目数据，不再只接收已经渲染好的 card JSON。
- 工作地图使用结构化专用布局器；项目进展与分歧沿用现有看板节点，并同样获得群内图片预览。本次不重写后两者的业务版式。
- 文字卡保持完整内容；白板显示可读概览，并保留来源数量、覆盖范围和待确认项。

### L2｜工作地图版式

- 顶部：标题、整理范围、配色和阅读说明。
- 主区：A/B/C 三条主线；项目卡显示名称、当前方向和状态；任务、阶段目标、子项目按层级缩进或嵌套。
- 关系：共用底座与确认过的父子关系使用连接线；不把未确认关系画成事实。
- 底部：待核对、覆盖缺口和历史区。
- 以 100% 可读字号为约束控制画布尺寸，避免为了放入全文而把概览压缩到 39% 才能看全。

### L3｜回归门禁与本地 review

- 新增结构测试：A/B/C 主线、父子项目、任务、阶段目标、待确认与历史区必须形成不同节点结构。
- 新增内容覆盖测试：群卡的完整文字仍保留；白板概览中的每个项目都能对应到结构化来源。
- 新增视觉快照：用与飞书写入完全相同的节点 JSON 生成本地预览，交 Ivy review。
- 从同一批节点渲染群聊预览图，上传为飞书 `image_key` 并放在卡片首屏；采用横向总览，必要时增加 A/B/C 主线细节图，避免把超高画布缩成不可读的小图。
- 图片点击后使用飞书内置图片预览；不把网页链接作为日常阅读入口。
- 使用当前真实内容的脱敏/本地副本验证多页和长文本边界。

## 待批准的生产步骤

### D1｜只读门禁与回滚资产

- 只读确认当前 revision、健康状态、restart count、白板 flag、`im:resource`、磁盘、active jobs 和 pending outbox。
- 要求 active jobs=0、pending outbox=0；使用 SQLite Backup API 建立完整性通过的快照，并保留当前 app checkpoint 与 rollback image。

### D2｜隔离候选与无业务数据探针

- 从下方候选提交构建带 revision 标签的隔离镜像；Noto CJK 安装、Sharp 加载、1160px PNG 渲染和 `<10MB` 必须全部通过。
- 运行一次无业务数据探针：上传一张只含核验文案的消息图片、创建一份测试白板、写入原生节点并授予唯一批准群编辑权限；不发群消息。

### D3｜切换与自动验收

- 再次确认空队列，停止 Bridge，原子切换 app 和镜像，启动后核对运行 revision、健康状态、restart count、ChatGPT 登录、无 API Key fallback 和所有既有 feature flags。
- 在服务器本地使用只读数据库生成一次当前真实工作地图 PNG，只记录尺寸、文件大小和 SHA-256，不发群消息、不回写数据库；确认三条主线、节点数量和卡片 payload 均在限制内。
- 任一门禁失败立即停止；若已经切换则按现有 checkpoint、SQLite 快照和 rollback image 回滚。

### D4｜唯一一次人工验收

- 自动检查全部通过后，才请 Ivy 在批准群输入一次 `查看工作地图`。
- 验收点只有三个：首屏直接看到风格化总览；完整文字仍在卡片中；次要按钮能打开可编辑白板。此前不再要求 Ivy 重复触发测试。

## 不在本次修复范围

- 不改变工作地图的业务归类或已确认的 A/B/C 层级。
- 不主动扩大飞书应用权限；若 D1 发现 `im:resource` 缺失，停止部署并单列权限变更。
- 不开启自动群推送，不读取非白名单群聊或私人聊天。

## 回滚

生产阶段继续使用现有 SQLite 一致性快照、应用 checkpoint 和旧镜像标签。若新版布局发布失败，恢复旧镜像只影响白板外观生成；文字卡兜底仍保留完整查询结果。

## 2026-10-14 D1–D2 执行记录

- D1 运行门禁通过：生产仍运行 revision `c99c1325dc8edd64cfff07ff3b89c5cdcb7529ef`，`running/healthy`、restart count `0`、`/health` 与 `/ready` 均为 200；active jobs=`0`、pending outbox=`0`、SQLite `integrity_check=ok`、无外键异常。capture/analysis/manual-query/daily-reconciliation/whiteboard/worker 均为 `true`，group delivery=`false`；ChatGPT 登录有效且没有 OpenAI API Key fallback。
- tracked-only 候选归档 SHA-256 为 `68f5896d95f18c65afe4998a932e99dbeee894a56c75d3de3c34bff9a233d8b3`。服务器隔离镜像 `aijia/feishu-codex-bridge:inline-e10cd6d` 的 OCI revision 为 `e10cd6d52504cdd4722f9b0ae4e23e3fe631a694`。
- 候选镜像包含 Noto Sans/Serif CJK 字体文件。使用候选运行时和正式 `renderFounderWhiteboardPng` 生成的无业务数据 PNG 为 1160×552、SHA-256 `7971520aa78b0ffaff1ff1070858e31bc28c937c7f81bd0df64b6958835f3f6a`，人工目检中文字符完整、无方框。运行时仍打印 Fontconfig 默认配置缺失告警，但本次实际像素输出正常；后续可通过安装 `fontconfig` 消除告警，不作为本次权限阻断的根因。
- 唯一一次获批的无业务数据探针在第一阶段 `upload_preview_image` 返回飞书码 `99991672`。由于失败发生在图片上传，未创建新的文档、白板或群消息；这直接证明生产应用尚未开通消息图片上传需要的 `im:resource`。
- 按本单停止条件，D3 未执行：Bridge 未停止、未重启、未替换 app／镜像、未修改 env／SQLite，也未读取真实业务内容进行渲染。失败后复核仍为原 revision、healthy、restart count `0`、active jobs=`0`、pending outbox=`0`、数据库完整。
- 下一步需单独批准：在 sharon 的生产 `Codex` 应用中只补齐并发布应用身份权限 `im:resource`，然后运行一次新的无业务数据探针。只有该探针完整通过图片上传、文档创建、白板节点和群编辑授权后，才恢复 D3；此前不邀请 Ivy 做 D4 群内测试。

## 2026-10-14 D3 执行记录

- `im:resource` 发布后的无业务数据探针已通过图片上传、文档/白板创建、节点写入与批准群编辑授权；未发群消息。D3 与获批的批量纠正恢复合并为一次停机窗口，避免重复重启。
- 切换前旧 revision `c99c1325dc8edd64cfff07ff3b89c5cdcb7529ef` 仍 healthy、restart 0、任务队列为空；唯一 pending outbox 是已确认过时的批量纠正澄清回执。候选 image ID `sha256:f9e2bb545c9fd45dc4b6eccf05639d30104e7fe24fedf684d66435f5d57ee6ac`，OCI revision 与候选提交完全一致。
- 生产现运行 revision `f04442e4702d4d65de7bf2212798aa5d50bac95f`，healthy、restart 0、health/ready 200、ChatGPT 登录有效，capture/analysis/daily reconciliation/manual query/whiteboard/worker 均为 true，group delivery=false，无 API Key fallback。
- 生产数据库只读生成结果为：23 个 canonical topic、20 个可见 topic、2 页完整文字卡、104 个白板节点；群内 PNG 为 1160×2347、152019B，SHA-256 `8854df602910211b9882f3c471ee3a3d128abc1db8a582d3c628146956f74bd2`。A/B/C 三条主线、完整文字保留、隐藏内容、状态纠正和图片限制自动断言全部通过；未发送群消息。
- 回滚资产保留于 `/opt/feishu-codex/backups/bridge-pre-correction-20261014T125608Z.sqlite`、`/opt/feishu-codex/checkpoints/app-pre-correction-20261014T125608Z` 和 `aijia/feishu-codex-bridge:rollback-pre-correction-20261014T125608Z`。下一步只需 Ivy 执行一次 D4 `查看工作地图`。
- 合并后的最终本地回归为 97 个测试文件、833 项测试全部通过，TypeScript typecheck、生产 build 和 `git diff --check` 全部通过。
