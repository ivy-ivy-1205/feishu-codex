# Founder 工作地图可读性与重复主题修复变更单

日期：2026-10-15  
状态：P1–P3 已完成；等待 Ivy 唯一一次群内验收

## 本次唯一群测结论

群内首屏直接展示风格化总览已经通过，完整文字与可编辑白板入口也都保留；当前交互形式不再调整。

本次结果仍不能通过最终验收，原因有两项：

1. `Riptide Cobalt` 配色下，至少四张“阶段目标／任务／观点”卡片显示为深蓝空白块。放大截图确认文字节点存在，但文字颜色与卡片背景同为 `#1A2240`。
2. 完整文字和历史区同时出现两个 `EP00《挺好》`：正文编号分别为 `#9` 与 `#14`。这不是视觉截断，而是两个主题经过展示清洁后得到相同名称；在确认底层关系前不能直接删除其中任何一个。

## 已定位根因

### R1｜配色可读性

当前 palette 构造从整套颜色中选一个最深色作为全局 `ink`。工作地图又用 `secondary`／`highlight` 作为阶段目标、任务和观点的底色，并继续用同一个 `ink` 写文字。

`Riptide Cobalt` 的 `secondary` 与 `highlight` 都是 `#1A2240`，恰好也被选为 `ink`，因此形成同色文字与背景。现有测试只断言文字节点存在、颜色字段合法，没有验证前景色与实际底色的对比度。

### R2｜同名主题

截图能证明当前投影里存在两个清洁后同名的 canonical topic，但不能仅凭截图判断它们来自名称标点差异、纠正匹配失败、历史 topic 未合并，还是关系投影重复。需要在批准后对生产库做一次只读核对，再决定匹配修复与防御性去重的精确范围。

## 修复范围

### L1｜逐卡片选择可读文字色

- 卡片标题、正文、状态和来源数都按该卡片的实际底色选择黑色或白色，不再复用整套 palette 的全局 `ink`。
- 主线标题、共用底座 footer 等彩色区域应用同一规则。
- 使用 WCAG 相对亮度计算，所有正文前景／背景组合要求对比度至少 `4.5:1`。
- 穷举 Ivy 收藏的 25 套配色，以及 `project`、`task`、`goal`、`idea` 四种卡片类型；任一组合不达标则构建失败。25 套仍会用于项目进展、共识与分歧，因此不能只验证工作地图专用池。
- 群内图片与可编辑白板继续使用同一批节点，避免只修 PNG、白板仍不可读。

### L2｜纠正匹配与防御性去重

- 先只读确认两个 `EP00《挺好》` 的 topic ID、原始名称、父级、阶段、authority、版本与来源关系；日志只保留聚合判断，不输出业务正文或来源 ID。
- 纠正命令匹配使用与展示一致的名称规范化，但只有在规范化名称唯一命中时才更新现有 topic；多命中或父级／阶段冲突时 fail closed，保留为待确认，不猜测合并。
- 工作地图投影对“规范化名称相同、父级兼容、阶段不冲突”的重复主题只展示一张卡，并合并来源计数与历史引用；底层 topic、版本、来源和关系均保留。
- 若两个同名条目的父级或阶段冲突，继续分别展示并明确标记“同名待确认”，不静默折叠。

### L3｜交互与内容边界

- 保持“群内直接看总览 + 完整文字 + 次要可编辑白板入口”的现状。
- 配色拆成两个独立池：`查看工作地图` 只从 Ivy 已确认的 `Grove`、`Salmon Stamp`、`Editorial Forest`、`Riso Brut`、`Court Press` 五套主视觉中随机；项目进展、项目共识和项目分歧继续从原 25 套收藏中随机。两个池都避免连续重复，同一次查询结果保持稳定。
- 两个池的权威配置记录在 `docs/workmap-palette-preferences.json`；蓝白 `Riptide Cobalt` 不属于工作地图池，但修复可读性后仍可用于项目进展、共识与分歧。
- 不改变 A/B/C 归类、暂停／结束语义、Founder 纠正优先级和回复卡片纠正入口。
- 不删除或改写历史证据，不读取非白名单群或私人聊天，不开启 API Key fallback。

## 生产步骤（待一次性批准）

### P1｜只读诊断

- 核对生产 revision、健康状态、restart count、active jobs、pending outbox、数据库完整性与 feature flags。
- 只读确认两个 `EP00《挺好》` 的重复路径与兼容关系；不改数据库、不调用 Codex、不发群消息。

### P2｜本地与隔离副本门禁

- 先增加失败测试，再实现 L1–L2；运行完整 `pnpm test`、`pnpm typecheck`、`pnpm build` 与 `git diff --check`。
- 构建隔离候选，在一致性生产数据库副本上生成当前工作地图，不启动 webhook、worker 或自动投递。
- 固定穷举全部 25 套收藏配色与四种卡片类型，要求每个有色文本区域对比度至少 `4.5:1`、不存在同色空白卡；另验证工作地图查询只会使用已确认的五套池，其他三类查询仍使用 25 套池。
- 当前生产副本地图还必须保持 A/B/C 结构不变、`EP00《挺好》` 只出现一次或被明确标记为冲突、PNG 小于 10MB。

### P3｜一次生产切换

- 队列空闲后停止 Bridge，保留 SQLite 一致性备份、app checkpoint 和 rollback image，再切换候选。
- 启动后核对 health/ready、restart count、数据库完整性、ChatGPT 登录、无 API Key fallback、flags 不变、group delivery=false。
- 在服务器只读生成工作地图专用池的当前数据 PNG，并用无业务数据 fixture 穷举其余 25 套的节点可读性；全部通过后清理派生图片和隔离副本，不发送群消息。
- 任一门禁失败立即恢复旧数据库、旧应用和旧镜像，不要求 Ivy 中途重复测试。

## 最终人工验收

只有 P1–P3 全部通过后，才请 Ivy 再发送一次 `查看工作地图`。验收重点只有两项：所有卡片文字可读；`EP00《挺好》` 不重复。该次调用仍应在群内直接看到总览，不需要打开网页。

## 回滚

- 生产切换前保留带时间戳的数据库备份、应用 checkpoint 与旧镜像标签，并记录 SHA-256、权限和 revision。
- 本次同名治理默认只改匹配与展示投影，不删除底层主题或证据；因此回滚代码即可恢复旧投影，数据无需破坏性逆向迁移。

## 执行结果

- P1 确认旧生产为 revision `f6ea74c5153c20a1fd41eb7b4e20058ac8e63645`，running/healthy、restart 0、health/ready 200、active jobs=0、pending outbox=0、数据库完整且无外键异常。两个同名条目均为 closed：旧 Founder baseline 隶属 B 线，新条目是带前导竖线且缺少右书名号的孤立分析结果；新条目的 rationale 已携带 canonical name，却因旧逻辑排除 closed topic 而重复建档。
- 本地修复提交为 `66cc65b`，门禁几何校正提交为 `558c39a`。最终 99 个测试文件、846 项测试，以及 `pnpm typecheck`、`pnpm build`、`git diff --check` 全部通过。工作地图只使用 5 套确认配色；项目详情、共识和分歧仍保留 25 套池。唯一且阶段兼容的规范名称会续写原主题，多命中时不再新建第三条；展示投影折叠兼容历史重复，父级或阶段冲突时标记“同名待确认”。
- P2 候选 image 为 `sha256:83d2746344c2f1408d0d06e89ea957f7f8d7c6f3dc513da4d7a2d91398765626`，OCI revision 精确为 `558c39a0c5678c6d8bc17237f2b301e41527112f`。生产一致性副本 SHA-256 为 `26dcd12f783915ca70448138893159bbe35d0b48da03e4de824a56477428fffe`；地图保持 A/B/C，33 个 canonical topic 投影为 18 个可见条目、2 页完整文字，`EP00《挺好》` 只出现一次。五套真实 PNG 均为 1160×2313、约 146–149KB，最低对比度 `4.762:1`；25 套无业务 fixture、四种卡片类型、900 个节点最低为 `4.758:1`。四个无业务中文字符渲染出四组不同字形，排除方框 fallback。
- 首次 P3 候选已经 healthy、ready 且 `codex login status` 实际返回 `Logged in using ChatGPT`，但该 CLI 把状态写到 stderr，部署脚本只检查 stdout，因此安全触发自动回滚。旧 revision、数据库、队列与登录随后全部核验正常。修正门禁为合并 stdout/stderr 后重试，同一候选成功切换。
- 当前生产运行 revision `558c39a0c5678c6d8bc17237f2b301e41527112f` / image `sha256:83d2746344c2f1408d0d06e89ea957f7f8d7c6f3dc513da4d7a2d91398765626`，startedAt `2026-10-15T09:02:19.045469977Z`，running/healthy、restart 0、health/ready 200、ChatGPT 登录有效、API Key fallback=0。capture/analysis/daily/manual/whiteboard/worker 仍为 true，group delivery=false，active jobs=0、pending outbox=0，数据库完整且无外键异常。部署后真实副本与 P2 的结构、PNG 哈希和对比度完全一致；未发送群消息。
- 正式回滚资产为 `/opt/feishu-codex/backups/bridge-pre-workmap-readability-20261015T090111Z.sqlite`（SHA-256 `26dcd12f783915ca70448138893159bbe35d0b48da03e4de824a56477428fffe`）、`/opt/feishu-codex/checkpoints/app-pre-workmap-readability-20261015T090111Z` 和 `aijia/feishu-codex-bridge:rollback-pre-workmap-readability-20261015T090111Z`。隔离数据库、派生 PNG、构建目录与候选标签已清理。
