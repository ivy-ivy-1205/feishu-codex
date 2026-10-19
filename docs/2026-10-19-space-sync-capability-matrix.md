# Space Sync 能力矩阵（Phase 0）

日期：2026-10-19（Asia/Shanghai）
执行环境：Claude Code（本次会话），工作目录 `/Users/mengxi/Projects/FeishuAdaptor/.worktrees/main-merge`，分支 `codex/space-sync-phase0-1`

## 1. 核验方法

本矩阵核验的是**执行此交接文件的 Claude Code 会话本身**可用的工具与 MCP 连接器清单,不是通用结论。核验方式是逐一检查本会话当前已加载和可通过 `ToolSearch` 延迟加载的全部工具/MCP 服务器名称,寻找任何与 ChatGPT Space、Pages connector、OpenAI 账号登录态相关的条目。

## 2. 结论总表

| 能力 | 状态 | 说明 |
|---|---|---|
| Page 正文读取 | **unsupported** | 本会话没有任何 ChatGPT Pages/Space MCP 连接器或工具。不存在访问通道,不是权限不足。 |
| Page 分页(pagination) | **unsupported** | 同上,无底层读取能力可供分页。 |
| Comments 读取(作者/时间/thread state) | **unsupported** | 同上。 |
| Page sequence / updatedAt 元数据 | **unsupported** | 同上。 |
| Pages automation 事件触发(T1) | **unverified** | 无法从本环境验证 Pages 是否支持 automation 或能否对外发 HTTPS 请求;需要在拥有 Pages connector 的环境(Codex App)中核验。 |
| Space producer 对 Bridge 的 HTTPS 调用能力 | **unverified** | 同上,属于 producer 侧能力,需在 Codex App 环境核验。 |
| Bridge 接收端(HMAC 入口、schema 校验、幂等、事务写入) | **supported** | 不依赖 Pages connector,可在本环境用 TDD 完整实现并用 fixture 验证。 |
| 本地 fixture / CLI / 隔离数据库测试 | **supported** | 同上。 |
| Founder 分析器 / evidence locator 扩展 | **supported** | 属于 Bridge 侧代码改造,不需要真实 Space 数据。 |
| Smart Listing 真实 Page 存在性/权限/标题校验(§5.4) | **blocked prerequisite,非阻塞** | 按 Ivy 批准,由当前 Codex App 环境(有 Pages connector)后续完成;不阻塞本会话完成 Phase 0–3。 |

## 3. 处理方式

- 本会话不会尝试通过网页抓取、复制登录凭据或提示词绕过第 2 节中标记为 `unsupported`/`unverified` 的能力。
- Phase 1–3 的全部实现与测试均使用符合真实 `SpaceSyncEnvelopeV1` schema 的 fixture 数据,不读取任何真实 Space 内容。
- Phase 4(真实 Page 只读试点)及其前置的真实权限/标题校验,标记为 blocked prerequisite,移交给有 Pages connector 的 Codex App 环境执行;本会话继续完成 Phase 0–3 的本地候选实现。
- T1(事件触发)与 T2(定时同步)方案的可行性验证同样移交 Codex App 环境;本会话只实现 T3(手动补偿 CLI)和 Bridge 侧对三种触发方式一致的接收路径,不对 T1/T2 做出"已验证可用"的断言。
