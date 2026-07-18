# AiJia Feishu × Codex Bridge

> **Phase 1A 仅完成本地 fixture 验证：没有连接真实飞书、没有可写 Codex 执行、没有部署。**

这个仓库当前证明一条安全、可审计的会议闭环：妙记生成事件进入 HTTP 入口，SQLite 原子写入 durable job，worker 用固定 transcript 与结构化 summarizer fake 生成纪要和编号 Todo，渲染后的私聊消息进入 outbox；fake delivery ack 绑定消息 ID 后，只有 Ivy 在该消息下回复“先干 1”才会得到低风险授权 decision。授权 decision 不会执行 Todo。

## 当前可验证的用户体验

```text
妙记 fixture
  → durable process_minute job
  → 个性化会后总结 + 编号 Todo
  → Ivy–Codex 私聊 outbox + delivery ack
  → Ivy 回复“先干 1”
  → authorize_low_risk decision（到此停止）
```

- 默认总结目标是 Ivy 与 Codex Bot 私聊 `oc_d851c3e986007dc0f97ab582bcb2e7c8`。
- 标题和时间来自妙记 transcript fixture；Todo capability 来自结构化 summarizer 输出，不根据标题猜测。
- 只有 `risk=low` 且 `capability=content_draft` 可以得到低风险授权 decision。
- 身份、私聊、reply context、投递证据或 capability 任一缺失都会 fail closed。

## 快速验证

当前 Mac 工作区可直接使用 Node.js 22 与 pnpm 10：

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm exec vitest run tests/meeting-loop.acceptance.test.ts
pnpm test
pnpm typecheck
```

完整的环境、fixture、数据库重置和本地服务说明见 [docs/local-development.md](docs/local-development.md)。

本地 `pnpm dev` 会先加载仓库根目录的 `.env`，并只为配置的 SQLite 文件创建其精确父目录；测试使用的 `:memory:` 模式不触碰文件系统目录。

## Phase 1A 明确不做

- 不调用飞书 API，不校验真实飞书签名或解密真实事件，不发送真实私聊消息。
- 不调用本地 `codex exec`，不保存 Codex/ChatGPT 登录凭据，不执行 Todo。
- 不处理群历史、文件、视频、普通音频或原生语音转写。
- 不连接客户生产数据库，不部署到腾讯云，不创建或修改云资源。

## 后续四个独立计划

1. `group-history-backfill`：群聊/thread 分页、附件/文档引用、覆盖率与原生语音策略。
2. `project-memory`：不可变来源层、版本化事实、决策、冲突和 `manual_ivy` 输入。
3. `codex-runtime-and-execution`：本地 Codex 登录 Gate、只读执行、低风险执行适配器及高风险二次确认。
4. `real-feishu-integration-and-deploy`：官方 SDK、真实妙记权限、私聊投递和腾讯云部署。

这些是已延期的后续能力，不是 Phase 1A 已完成的能力。
