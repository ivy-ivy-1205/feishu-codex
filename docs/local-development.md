# 本地开发与验收

## 运行时

2026-07-18 当前 Mac 工作区为 Darwin arm64，已提供：

- Node.js `v22.23.1`：`/Users/mengxi/.local/bin/node`
- pnpm `10.28.2`：`/usr/local/bin/pnpm`

项目要求 Node.js 20+。先用下面的命令确认当前 shell 解析到可用运行时：

```sh
command -v node
node --version
command -v pnpm
pnpm --version
```

安装锁定依赖：

```sh
pnpm install --frozen-lockfile
```

`better-sqlite3` 是唯一被项目 `pnpm-workspace.yaml` 允许执行 native build script 的直接依赖。不要全局放开依赖脚本。

## 环境配置

复制配置契约样例：

```sh
cp .env.example .env
```

`pnpm dev` 使用 Node 的 `--env-file=.env` 在加载 `src/server.ts` 前读取该文件；缺少 `.env` 时会直接失败，而不会带着不完整配置启动。

`.env.example` 中的 app ID、secret、verification token 和 encrypt key 只是占位值，不能用于真实飞书。为防止样例配置被误当成可运行服务，`NODE_ENV` 非 `test` 时会拒绝仓库中的 `fixture-verification-token`；运行 `pnpm dev` 前把 `FEISHU_VERIFICATION_TOKEN` 换成本机随机值，不要提交 `.env`。私聊 `chat_id` 是消息目的地，不是 Ivy 身份；`FEISHU_APPROVER_OPEN_IDS` 保持空值时，reply router 只会返回 `identify_ivy`，不会授权。

服务默认 `HOST=127.0.0.1`，因此只接受本机连接。只有后续真实飞书集成明确配置 HTTPS 入口时才设置 `HOST=0.0.0.0`；删除或省略 `HOST` 不会意外暴露公网监听。

`WORKER_LEASE_SECONDS` 必须严格大于 `CODEX_TIMEOUT_SECONDS`。默认分别为 180 秒和 120 秒，避免下游仍在运行时 lease 已被其他 worker 回收；失去 lease 的 worker 返回 `lost_lease`，不会写入完成、重试或失败状态。

Phase 1A 测试直接注入依赖，不从 `.env` 读取真实凭据。不要把真实 secret、Codex 登录信息或客户数据库连接写入仓库。

## 最小验收闭环

运行单个 acceptance 文件：

```sh
pnpm exec vitest run tests/meeting-loop.acceptance.test.ts
```

该测试在全新的 SQLite `:memory:` 数据库中完成以下步骤：

1. 通过 Fastify `inject` 把 `src/fixtures/minute-generated.json` 送入 webhook。
2. 验证入口只生成一个 `minute:min_fixture_1` durable job，不内联运行 worker。
3. worker 从 `src/fixtures/minute-transcript.json` 取得真实 fixture 标题、时间和逐字稿。
4. 结构化 summarizer fake 明确返回每个 Todo 的 `risk` 与 `capability`；没有 capability 默认值或标题推断。
5. worker 在事务前验证结构化输出的字段、数组和整体 UTF-8 byte 上限，再渲染“核心信息 / 我可以帮你推进”，并把正文、会议元数据和结构化 Todo 一起写入 durable outbox；没有 Todo 时明确显示暂无可推进事项。
6. fake sender 只做 delivery ack，把 `om_fixture_meeting_summary_1` 绑定到 summary；不发网络请求。
7. 测试确认 Ivy fixture `open_id` 后，再通过同一个 HTTP webhook 回复“先干 1”。
8. 最终只断言 `authorize_low_risk` decision 和精确 Todo；没有 executor，因此不会修改文件、发消息或部署。

## 全量检查

```sh
pnpm test
pnpm typecheck
git diff --check
```

安全审计：

```sh
rg -n "OPENAI_API_KEY|danger-full-access|docker push|kubectl|aws_|production" src tests .env.example
```

允许出现的 `production` 仅限配置环境枚举、fail-closed capability 及授权拒绝测试；不得存在生产访问实现。

## 本地数据库与重置

自动化测试使用 `:memory:`，每次运行都是新数据库，无需清理。若运行本地进程，默认持久化文件是 `data/aijia-context-bridge.sqlite`。

启动时会在 SQLite 文件模式下递归创建配置文件的精确父目录；不会为 `:memory:` 创建目录，也不会删除或清空任何已有路径。需要重置时先停止进程，再把旧库移动成可恢复备份：

```sh
mv data/aijia-context-bridge.sqlite data/aijia-context-bridge.sqlite.backup
```

文件或父目录不存在时无需手工创建或执行移动。下次启动会安全创建父目录并重新建表。确认备份不再需要前不要删除它。

## 本地 HTTP 服务的真实边界

```sh
pnpm dev
```

- `GET /health` 只表示进程存活。
- `GET /ready` 当前应返回 `503 WORKER_UNAVAILABLE`，因为 Phase 1A server 没有启动 durable-job consumer。
- `POST /webhooks/feishu/events` 可验证本地 envelope、幂等入队和 reply decision。
- 本地进程不会自动运行 worker；完整 fixture injection + 单次 worker cycle 由 acceptance harness 明确驱动。

因此，不能因为 `/health` 为 200 或 acceptance test 通过，就宣称真实飞书、真实 Codex 或腾讯云部署已完成。

## 已延期能力

- `group-history-backfill`
- `project-memory`
- `codex-runtime-and-execution`
- `real-feishu-integration-and-deploy`

真实飞书连接、群历史与文件、原生语音转写、公司项目记忆、Codex 任务执行和腾讯云部署分别属于这些后续计划。
