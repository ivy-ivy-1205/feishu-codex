# Phase 1a 服务器治理与 Phase 1b 妙记总结卡片化设计

## 目标与边界

本增量同时完成两件事：为 Feishu Codex Bridge 落实资源上限、串行消费、SQLite 备份与 300 秒 Codex 超时；把 Ivy 私聊中的妙记总结从纯文本升级为飞书 schema 2.0 interactive 卡片。

服务器清理、删除、root crontab、生产 env 修改和容器重启必须先给出命令、效果和风险，待 Ivy 明确批准后由 Ivy 执行或另行授权。测试期交付目标仍是 Ivy 私聊，不增加飞书权限，不自动执行 Todo。

## 稳定数据层

新增 `src/schema/summary.ts`，用 Zod 定义并运行时校验 Summary JSON Schema v1：

- `schema_version` 固定为 `1.0`。
- `meeting` 保存标题、日期、时长和参与者。
- `key_points`、`decisions`、`open_questions` 保存总结内容。
- `todos` 保存标题、详情、负责人提示、八类 `action_type`、项目对齐状态、建议项目、直接指令标记、隐含待办推理和截止提示。
- `source` 保存妙记 URL 与 token，落实来源追溯。

`alignment/suggested_project` 是 Phase 4 项目对齐管道闸门的预埋钩子；`action_type` 是后续执行方案路由的稳定分类。Schema 是 Agent/平台无关的稳定层。

现有数据库 Todo 授权模型继续保留 `risk/capability`，避免破坏 Ivy 回复编号 Todo 的授权闸门。Summary v1 到持久化 Todo 的兼容映射必须 fail-closed：不能证明安全的 action 一律映射为不可直接执行。

## Summarizer

Codex 只输出符合 Summary v1 的 JSON，不带 Markdown 围栏或额外文本。提取规则：

- 待办宁多勿漏，但不得凭空编造。
- 隐含待办必须填写 `reasoning`。
- 妙记自带 AI 待办与逐字稿自行提取结果交叉检查。
- `WAKE_WORD` 默认空，表示关闭。仅扫描 Ivy 本人发言；命中后把唤醒词后的指令标为 `is_direct_instruction: true`，讨论语境中的普通提及跳过。
- 发言人名尽量归一，输出语言跟随逐字稿。
- 本阶段只识别直接指令，不执行。

## 卡片渲染与投递

`src/card/renderer.ts` 把已验证的 Summary v1 渲染为飞书 schema 2.0 卡片：

1. header：会议标题、日期与时长；
2. 要点；
3. 决策；
4. 待办：直接指令置顶并标记，显示 action type 中文标签、owner hint 与 alignment；
5. 待定问题；
6. footer：妙记原文链接。

空 section 整段省略，不提供按钮。卡片使用 `update_multi: true`，正文使用 markdown 元素和分隔线。

正常路径发送 `msg_type: interactive`。如果 Summarizer 原始输出无法解析或不符合 Schema v1，则记录 warn（失败原因与原始输出最多 500 字符），并使用现行纯文本渲染和 `msg_type: text` 投递。任何失败都不能静默丢消息；日志不得包含 secret。

## 资源治理

- Compose 为 bridge 设置 `mem_limit: 512m`。
- Worker 保持单 consumer、单次只 lease 一个 job；不增加并发参数。
- `CODEX_TIMEOUT_SECONDS` 默认值和 example 改为 `300`，生产 env 由 Ivy 编辑。
- `deploy/backup-sqlite.sh` 使用 SQLite `.backup` 创建一致性备份到 `/opt/feishu-codex/backups/`，成功后只保留最近 14 份。
- 修正 `AGENTS.md` 中“尚未连接真实飞书或部署”的过期状态。

## 测试与验收

- Schema：覆盖合法数据、非法枚举、隐含待办缺 reasoning、source 缺失。
- Renderer：覆盖结构、直接指令置顶、空 section 省略和原文链接。
- Delivery：覆盖 interactive 正常投递和校验失败后的纯文本降级。
- 集成：fixture 逐字稿走通 summarize → validate → render。
- 本地门禁：`pnpm test`、`pnpm typecheck`、`pnpm build`。
- 部署前确认 durable job 队列为空；A3 与 Phase 1b 合并为一次容器重建/重启。
- 部署后 `/health`、`/ready` 均为 200，容器内存上限为 512 MiB。
- 真实短会验收卡片四要素、坏 JSON 降级和全程零人工介入。

## 回滚

部署前记录当前 Git commit 和镜像。失败时恢复上一 commit 的 app 内容并用同一 compose 重建；SQLite schema 不做破坏性迁移，现有数据库与 Codex 登录挂载保持不变。
