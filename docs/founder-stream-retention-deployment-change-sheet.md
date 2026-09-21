# Founder Stream Retention Patch 精确部署变更单

状态：**提交 Ivy review，不构成执行授权。**

目标：只把90天正文保留所需的数据库结构和受控运维工具部署到腾讯云，不替换当前生产 Bridge，不持久化14条群消息，不启动 Founder Stream。

## 1. 为什么不直接部署 `f5c9f50` 为 Bridge

本地 checkpoint `f5c9f50 feat: add founder stream retention controls` 建立在当前 `main` 上；当前 `main` 还包含尚未在生产启用的 Founder Stream capture、analysis、group delivery 和相关 Phase 1D/1E 代码。生产 Bridge 当前镜像仍是 `aijia/feishu-codex-bridge:local` 的既有版本。

直接替换 Bridge 会扩大成“整套 Founder Stream 上线”，不符合本次只部署 retention patch 的授权边界。

本次采用独立一次性工具镜像：

- 镜像只作为 migration/preview/redaction CLI 的运行载体。
- 不运行 HTTP server 或 worker。
- migration 容器使用 `--network none`，不接触飞书、Codex 或外网。
- 生产 Bridge 停机迁移后仍使用原镜像和原配置启动。

## 2. 本次精确变更

### 数据库只新增三列

表：`context_sources`

| 列 | 类型与默认值 | 用途 |
|---|---|---|
| `raw_text_expires_at` | `TEXT NULL` | 原始正文到期时刻 |
| `content_state` | `TEXT NOT NULL DEFAULT 'cleartext'` | `cleartext` / `redacted` |
| `redacted_at` | `TEXT NULL` | 实际脱敏时刻 |

迁移要求：

- 三个 `ALTER TABLE` 必须在同一个 SQLite `BEGIN IMMEDIATE` 事务中执行。
- 必须先确认三列全部不存在；若只存在其中一部分，停止并报告，不自动补齐。
- 必须确认 `context_sources` 当前基础列和约束符合预期；不符合时停止。
- 不运行项目通用 `migrateDatabase()`，避免顺带修改 job payload、Todo、Outbox 或其他表。
- 不回填现有来源的到期时间；现有1条 `minute_transcript` 不在本次90天群消息策略内。

### 独立工具镜像

计划标签：

```text
aijia/feishu-codex-retention:<新的审计提交短 SHA>
```

镜像包含两个受控入口：

1. `context-source-retention-migrate`：只执行上述三列的幂等、事务化迁移与结构验证。
2. `context-source:retention`：已经实现的精确 source-ID `--preview` / `--execute` 工具。

`f5c9f50` 只包含 retention 数据模型和 preview/execute CLI。D0 后续 checkpoint 已补齐独立的“三列限定 migration CLI”：它要求显式 `--apply`，严格核对基础 schema，拒绝部分迁移和异常完整迁移，并用单一 `BEGIN IMMEDIATE` 事务添加三列。不得用通用 migration 或临时内联 SQL 绕过。

## 3. 已知生产基线（2026-09-21只读 Preflight）

| 项目 | 已核对状态 |
|---|---|
| Bridge | running / healthy / restart count 0 |
| `/health`、`/ready` | HTTP 200 / 200 |
| 数据库 | `/opt/feishu-codex/data/bridge.sqlite`，约380 KiB，mode 600 |
| SQLite完整性 | `integrity_check=ok`，foreign-key violation 0 |
| retention三列 | 全部不存在 |
| 活动job | 无 queued/retry/processing |
| Outbox | 仅7条 delivered |
| Context source | 仅1条 `minute_transcript` |
| 磁盘 | 清理后约9.6 GiB可用，使用率85% |
| 生产Bridge镜像 | `aijia/feishu-codex-bridge:local` |
| Dry-run镜像 | `aijia/feishu-codex-dry-run:f38e0c2`，审计ID匹配 |
| Founder开关 | 当前容器env中未显式设置；不能表述为“显式false” |

生产基线可能变化，正式执行前仍需一次更窄的即时只读确认。

## 4. 影响范围

### 会发生

- 构建并保留一个独立 retention 工具镜像。
- Bridge 短暂停机，预计维护窗5分钟，实际目标小于2分钟。
- 创建一个本变更专属 SQLite 一致性备份。
- `context_sources` 新增三列。
- 原 Bridge 使用原镜像、原env、原volume重新启动。

### 不会发生

- 不替换生产 Bridge 镜像或应用代码。
- 不修改 Nginx、飞书后台、DNS、证书或 Secrets。
- 不读取飞书生产数据。
- 不持久化14条群消息，不创建 Founder batch job。
- 不调用 Codex，不消耗订阅额度。
- 不发送飞书消息。
- 不开启 capture、analysis 或 group delivery。
- 不删除 Docker 镜像、rollback资产、数据库行或备份。

## 5. 分步执行与审批门

每一阶段完成后停止并汇报；下一阶段需 Ivy 单独批准。

### D0 — 本地补齐限定 migration CLI

动作：

1. 测试先行，覆盖：全新三列迁移、重复运行无副作用、部分迁移拒绝、基础schema不符拒绝、事务失败全部回滚。
2. migration CLI 只接受 SQLite `DATABASE_URL`，不读取飞书或Codex配置。
3. 输出只包含迁移前后列状态、完整性和行数，不输出正文或ID。
4. typecheck、build、全量测试和独立review通过。
5. 创建新的本地审计 checkpoint，不推送、不部署。

停止条件：任何测试或review未通过。

### D1 — 即时只读确认

动作：

- 核对原 Bridge 容器ID、镜像ID、运行状态、重启次数和compose路径。
- 核对数据库路径、权限、大小、三列仍全部不存在。
- 核对无 queued/retry/processing job。
- 核对磁盘可用空间不少于6 GiB。
- 核对 `/health`、`/ready` 均为200。
- 记录原 Bridge 镜像ID，用于确认重启后没有换镜像。

停止条件：任一基线不符、三列出现部分迁移、磁盘低于6 GiB或存在活动job。

### D2 — 构建独立 retention 工具镜像

动作：

- 从D0的新审计提交创建只包含受控CLI的构建上下文。
- 构建 `aijia/feishu-codex-retention:<sha>`。
- 记录镜像ID、大小和创建时间。
- 先用临时 SQLite fixture、`--network none` 验证migration和preview入口。
- 临时容器执行后删除；保留工具镜像。

停止条件：构建失败、镜像入口不唯一、fixture迁移结果不符、镜像需要Secrets或网络。

### D3 — 进入关闭态并创建一致性备份

动作：

1. 再次确认无 active job。
2. 停止 `feishu-codex-bridge`，不删除容器。
3. 确认宿主 `127.0.0.1:3010` 不再提供服务，记录停机开始时间。
4. 以 `--network none` 启动一次性备份容器，只挂载：
   - `/opt/feishu-codex/data:/app/data:ro`
   - `/opt/feishu-codex/backups:/app/backups:rw`
5. 使用 SQLite backup API 生成：

   ```text
   /opt/feishu-codex/backups/bridge.pre-retention-<UTC timestamp>.sqlite
   ```

6. 备份文件权限设为600；验证 `integrity_check=ok`、foreign-key violation 0、文件大小大于0。
7. 对比原库/备份的关键表聚合计数，不查询正文。

备份说明：这是迁移恢复点，不是长期定时备份。它包含既有妙记数据，迁移与14来源持久化稳定后再提交精确清理申请；本次不自动删除。

停止条件：Bridge无法停止、备份失败、完整性异常或计数不一致。若停止，直接执行R1恢复原Bridge，不迁移。

### D4 — 关闭态三列迁移

动作：

- Bridge保持停止。
- 使用D2镜像，`--network none`。
- 不挂载Secrets、Codex home、logs或workdir。
- `/opt/feishu-codex/data:/app/data:rw` 是唯一可写业务挂载。
- 运行限定 migration CLI。

必须得到：

- `migrationApplied=true`
- 三列由 `absent/absent/absent` 变为 `present/present/present`
- `content_state` 对全部既有行均为 `cleartext`
- `raw_text_expires_at` 与 `redacted_at` 对全部既有行均为NULL
- `integrity_check=ok`
- foreign-key violation 0
- 所有业务表行数除schema变化外保持不变

停止条件：CLI非0退出、出现部分列、已有数据被回填、表计数改变或完整性异常。Bridge保持停止，进入R2数据库回滚。

### D5 — 启动原 Bridge并验证

动作：

1. 启动原 `feishu-codex-bridge` 容器。
2. 确认容器使用D1记录的原镜像ID，没有切换到 retention 工具镜像。
3. 验证 running、healthy、restart count无异常。
4. 验证 `/health=200`、`/ready=200`。
5. 只读验证job/outbox/source聚合计数与D3基线一致。
6. 观察5分钟，确认没有crash loop或新增失败job。

验收完成后仍不运行14来源persist。下一步需回到 [14个文本来源持久化变更单](./founder-stream-14-source-persist-change-sheet.md) 单独审批。

## 6. 回滚条件与动作

### R1 — 备份前失败

适用：D3停止Bridge后、备份尚未成功。

- 不修改数据库。
- 直接启动原Bridge。
- 验证原镜像ID、health、ready和队列聚合。

### R2 — 迁移失败或写后验证失败

适用：D4开始后，任何迁移/验证异常。

1. Bridge保持停止。
2. 保存失败数据库的只读现场副本，权限600；不覆盖成功备份。
3. 用已验证的D3备份恢复原数据库路径。
4. 校验恢复后完整性、外键和关键表计数。
5. 启动原Bridge，验证原镜像ID、health、ready。
6. 报告失败点；不得自动重试迁移。

由于整个写入阶段Bridge关闭，正常情况下不存在需要保留的并发新数据库写入。若发现停机后仍有写入者，禁止整库覆盖，停止并提交行级恢复方案。

### R3 — 迁移成功但Bridge启动失败

- 先判断失败是否明确来自旧代码不兼容新增nullable/default列。
- 不修改生产代码、不换新Bridge镜像尝试“顺手修复”。
- 执行R2恢复原数据库，再启动原Bridge。

## 7. 成功标准

同时满足才算完成：

- retention工具镜像存在且有审计镜像ID。
- 生产数据库仅新增批准的三列。
- 既有业务数据、job、outbox、source聚合计数不变。
- 原Bridge镜像未替换，服务healthy/ready。
- 未读取飞书、未调用Codex、未发送消息。
- 备份路径、校验、维护窗起止和执行结果进入受保护运维审计，不包含正文或凭据。

## 8. 当前审批状态

| 项目 | 状态 |
|---|---|
| 本变更单review | 待 Ivy |
| D0限定migration CLI实现 | 已批准并在本地完成，未部署 |
| D1即时只读确认 | 待单独批准 |
| D2工具镜像构建 | 待单独批准 |
| D3停服与一致性备份 | 待单独批准 |
| D4数据库迁移 | 待单独批准 |
| D5原Bridge重启与验证 | 待单独批准 |

review通过不等于批准任何服务器动作。
