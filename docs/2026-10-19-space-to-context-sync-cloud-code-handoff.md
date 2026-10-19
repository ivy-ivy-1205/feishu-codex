# Space → Context → 飞书工作地图：Cloud Code 实施交接

日期：2026-10-19（Asia/Shanghai）  
交接对象：Cloud Code／Claude Code 执行者  
项目：Project 6 / FeishuAdaptor  
工作目录：`/Users/mengxi/Projects/FeishuAdaptor/.worktrees/main-merge`  
交接时本地 HEAD：`c3910828f4a88c8dc41f9b2e5e5b71d85b8f30d7`  
当前生产业务 revision：`558c39a0c5678c6d8bc17237f2b301e41527112f`（`c391082` 仅为部署记录文档提交）

## 1. 结论与任务目标

当前公司有两个对齐工作面：

1. **飞书“对齐工作室”**：承接飞书群消息、飞书通话／妙记、人工纠正，并通过机器人提供“查看工作地图”“查看项目进展”“查看分歧”。
2. **ChatGPT Space 项目 Page**：承接单个项目的持续推进。项目发起人和成员会编辑正文、修改状态、补充产物并发表评论。

现有飞书 Bridge 不能读取 Space Page 或评论，因此工作地图主要基于飞书通话和群消息，无法及时看到 Space 中发生的项目变化。

本任务的目标不是让飞书机器人直接登录或抓取 Space，而是增加一个独立的 **Space 同步器**：

```text
飞书消息／妙记／纠正 ───────┐
                            ├──> 统一 Context 数据库 ──> 工作地图／项目进展／共识与分歧
Space Page／评论 ─> 同步器 ─┘
```

产品分工固定为：

- **Space 是单个项目的工作现场。**
- **Context 数据库是统一事实账本。**
- **飞书机器人是跨项目查询和展示入口。**

完成后，团队继续在 Space 中编辑和评论，不需要把同一内容手工复制到飞书；机器人基于已经同步进 Context 的两类来源生成跨项目总览。

## 2. 为什么要这样做

### 2.1 不能继续只依赖飞书语料

项目立项以后，大量更具体的目标、实施路径、产物、修改和评论发生在 Space。只读飞书会导致：

- 项目阶段和完成状态滞后；
- Space 中已经解决的问题仍显示为待推进；
- 评论中的不同理解无法进入分歧分析；
- 用户必须在两个系统重复表达，长期不可持续。

### 2.2 不能假设服务器 Codex CLI 可以读取 Space

当前 Codex App 中的 Pages connector 可以读取有权限的 Page 和评论，但服务器上的 Codex CLI 登录只证明 ChatGPT 登录有效，**不等于拥有 Pages connector 或公开 Space API**。不能通过提示词、复制登录凭据或网页抓取绕过这个边界。

因此需要把系统拆成两个独立角色：

- **Space producer**：运行在确实拥有 Page 读取权限和 Pages connector 的环境；读取并生成严格结构化的增量包。
- **Bridge consumer**：运行在 FeishuAdaptor 服务器；验证来源、登记关系、幂等写入 Context，再进入现有分析和工作地图链路。

这种分离允许 Cloud Code 先完整实现并测试 Bridge 侧，而不伪造 Space 权限，也避免把个人 ChatGPT 登录凭据复制到服务器。

### 2.3 Context 必须继续保留来源，而不是只保存最新摘要

Space 页面会反复编辑，评论可能被解决，成员也可能表达不同观点。如果只保存一个最新摘要，就无法回答：

- 谁在什么时间表达了什么；
- 当前正文由哪个版本支持；
- 一项结论是共同决定、页面维护者陈述，还是个人评论；
- 新内容纠正、补充还是冲突于旧内容。

所以 Page 正文和评论都必须进入不可变来源层；工作地图只是这些来源的当前投影。

## 3. 已有实现与可复用部分

不要新建第二套项目或证据系统。当前代码已经具备以下基础：

- `projects`、`project_mapping_rules`：位于 `src/db/migrate.ts`、`src/db/schema.ts` 和 `src/repositories/project-repository.ts`。
- `context_sources`：支持同一 `logical_key` 的多版本、内容哈希去重、来源作者、定位 URI、原文保留和 availability 状态。
- `context_source_relations`：支持 `derived_from`、`part_of`、`revises`。
- `context_evidence`：支持可追溯 excerpt 与 locator。
- `context_candidates`、`context_records` 及项目映射：已有通用 Context 抽取／审核基础。
- Founder 工作地图当前入口：
  - `src/services/founder-manual-query.ts`
  - `src/services/current-founder-work-map.ts`
  - `src/services/founder-stream-worker.ts`
  - `src/ports/founder-stream-analyzer.ts`
- 当前生产工作地图已经实现群内风格化总览、完整文字和可编辑白板入口，不要修改这套交互形式。

当前缺口：

1. 没有 `project_key ↔ Space Page` 的稳定登记关系。
2. Founder 分析输入仅允许 `group_message` 和 `minute_transcript`。
3. Evidence locator 只支持妙记和飞书群消息。
4. 没有受认证的 Space 增量入口、同步游标、同步运行记录和 Space 新鲜度状态。
5. `founder_topic_visibility.visibility='space_managed'` 当前意味着从工作地图隐藏；它混淆了“由谁维护”和“是否展示”。新方案必须拆开这两个概念。

## 4. 范围和非目标

### 本期必须完成

- 建立项目与 Space Page 的登记表。
- 以一个真实项目完成同步试点。
- 定义并实现版本化、幂等、可审计的同步协议。
- 读取 Page 正文和评论时保留作者、时间、版本、链接和评论状态。
- 将 Space 来源接入 Context 与 Founder 分析。
- 在工作地图中合并飞书与 Space 证据。
- 展示两类来源各自的新鲜度和缺口。
- 验证自动触发、定时回退和手动补偿三种触发方式。

### 本期不做

- 不让飞书机器人反向自动编辑 Space。
- 不把评论自动升级为共识。
- 不抓取 ChatGPT 网页，不复制 Cookie、token 或个人登录凭据。
- 不读取未登记的 Space 或其他私有 Page。
- 不扩大飞书白名单群范围。
- 不改变现有工作地图交互、配色池和人工纠正入口。
- 不引入 OpenAI API Key 或隐藏的按量模型调用。
- 不自动执行 Page 中出现的 Todo。

## 5. 项目登记表

### 5.1 复用 `projects`

`projects` 继续作为内部项目主表。不要用 Page 标题充当稳定主键。项目更名只能更新 `display_name`／aliases，`project_key` 保持不变。

### 5.2 新增 `project_space_bindings`

建议字段：

```sql
CREATE TABLE project_space_bindings (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  provider TEXT NOT NULL CHECK(provider = 'chatgpt_space'),
  space_id TEXT,
  page_id TEXT NOT NULL UNIQUE,
  page_url TEXT NOT NULL,
  management_mode TEXT NOT NULL CHECK(management_mode IN ('space', 'hybrid')),
  sync_mode TEXT NOT NULL CHECK(sync_mode IN ('manual', 'scheduled', 'event')),
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'permission_lost')),
  last_seen_sequence INTEGER,
  last_page_updated_at TEXT,
  last_synced_at TEXT,
  last_successful_sync_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

要求：

- 一个 Page 只能绑定一个 `project_key`。
- 未登记 Page 的数据一律拒绝进入 Context。
- `space_id` 可以为空，因为部分 Page 可能为私有 Page；不得编造 Space ID。
- `management_mode` 只说明主要维护场所，不决定是否出现在工作地图。
- `status=permission_lost` 时保留历史来源并显示缺口，不删除项目。

### 5.3 新增 Founder topic 与项目的稳定绑定

Founder `context_topics` 与已有 `projects` 当前没有稳定外键。不要继续依赖名称模糊匹配。新增类似：

```sql
CREATE TABLE founder_topic_project_bindings (
  topic_id TEXT NOT NULL REFERENCES context_topics(id),
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  role TEXT NOT NULL CHECK(role IN ('canonical', 'child', 'related')),
  source TEXT NOT NULL CHECK(source IN ('human_confirmed', 'mapping_rule', 'analysis')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(topic_id, project_key, role)
);
```

试点项目的 `canonical` 关系必须人工确认后写入。分析只能提出候选，不能自动覆盖已有人工关系。

### 5.4 真实试点项目

优先使用：

- 项目：Smart Listing／买家空间一线；
- 已知候选 Page：《AiJia Smart Listing 与买家空间项目总览》；
- 用户曾提供的候选地址：`https://chatgpt.com/space/page_f095a79b4bb48191b797811f8f53862d`。

执行者必须先验证该 Page 仍存在、当前账号可读、标题和项目归属一致，再写正式 binding。不能仅凭历史截图直接认定。

## 6. Space 同步协议

### 6.1 来源类型

沿用 `context_sources`，增加以下 `source_type` 值：

- `space_page_snapshot`
- `space_page_comment`
- `space_sync_coverage`
- `space_sync_gap`

建议 logical key：

```text
chatgpt_space:page:<page_id>
chatgpt_space:page:<page_id>:thread:<thread_id>:message:<message_id>
chatgpt_space:page:<page_id>:coverage:<sync_id>
chatgpt_space:page:<page_id>:gap:<sync_id>:<gap_code>
```

同一 Page 正文每次实际变化产生新的 `source_version`；相同内容哈希重复同步必须幂等。每条评论消息使用稳定 message ID，不要把整个评论区拼成一个不断变化的文本源。

### 6.2 同步 envelope

Bridge 侧定义严格 Zod schema，示意：

```ts
interface SpaceSyncEnvelopeV1 {
  schemaVersion: 1;
  syncId: string;
  projectKey: string;
  trigger: 'manual' | 'scheduled' | 'event';
  capturedAt: string;
  page: {
    pageId: string;
    spaceId: string | null;
    url: string;
    title: string;
    sequence: number | null;
    updatedAt: string | null;
    blocks: Array<{
      id: string;
      hash: string;
      markdown: string;
    }>;
  };
  comments: Array<{
    threadId: string;
    messageId: string;
    authorId: string;
    authorDisplayName: string | null;
    body: string;
    createdAt: string;
    editedAt: string | null;
    threadState: 'open' | 'resolved';
    resolvedAt: string | null;
    targetBlockId: string | null;
    selectedText: string | null;
  }>;
  coverage: {
    pageComplete: boolean;
    commentsComplete: boolean;
    nextCursor: string | null;
    gaps: Array<{ code: string; summary: string }>;
  };
}
```

`blocks` 是 Page 正文的唯一输入，必须保留原顺序；Bridge 从 blocks 派生并保存规范化 `content_text`。不要同时接收 producer 提供的另一份 `contentMarkdown`，否则两份正文可能不一致，无法确定哪一份可作为证据。

如果 Page 或评论分页未读完，必须 `commentsComplete=false` 并记录 cursor／gap。不能把部分读取表述为完整同步。

### 6.3 Bridge 入口和认证

新增内部入口，例如：

```text
POST /internal/space-sync/v1/ingest
```

要求：

- 默认关闭：`SPACE_SYNC_INGEST_ENABLED=false`。
- 请求体限制不得超过现有 `CONTEXT_SOURCE_MAX_BYTES`，并为 blocks/comments 设置数量上限。
- 使用独立 HMAC secret 文件，不把 secret 值写入仓库、日志或 `MEMORY.md`。
- 签名覆盖原始 body bytes、时间戳和 `syncId`。
- 拒绝过期时间戳、重复 `syncId`、签名错误、未知 `projectKey`、未登记 `pageId`、Page 与项目绑定不一致及超限数据。
- 同一个 envelope 的来源写入、coverage、binding 游标和同步 receipt 必须在一个事务内完成。
- 入口不得发送任何飞书消息，不得直接执行 Todo。

建议增加 append-only `space_sync_runs`，记录 `sync_id`、binding、trigger、开始／完成时间、page version、正文／评论新增数、coverage、status 和错误码。业务正文不要写入运行日志。

### 6.4 Evidence locator

扩展 `src/domain/context.ts` 与校验器，新增：

- `space_page_block`：`pageId`、`blockId`、`blockHash`，必要时含 UTF-16 offset。
- `space_comment`：`pageId`、`threadId`、`messageId`、可选 `targetBlockId`。

所有模型输出引用的 excerpt 必须能在对应 source 中逐字找到；继续保留现有 grounded validation。

## 7. 内容治理规则

### 7.1 页面正文和评论的含义不同

| Space 内容 | Context／工作地图中的含义 |
|---|---|
| 页面正文的项目目标、阶段、负责人 | 当前项目维护陈述，保留页面版本和修改时间 |
| 某个人的评论 | 该成员的个人表达、提议或问题 |
| 未解决评论 | 待回应问题或潜在分歧，不自动判定为 blocker |
| 已解决评论 | 历史上处理过的讨论，不自动判定为共识 |
| 明确标注并有确认依据的共同决定 | 才能进入 `shared_decision` |
| 没有人回复 | 未表达，不是同意 |

### 7.2 来源优先级

不要简单做“Space 覆盖飞书”。推荐规则：

1. Ivy 明确的结构化纠正／双方明确确认的共同决定；
2. Space 页面中带明确决策标识且能确认授权者的内容；
3. Space 当前正文中的项目维护陈述；
4. 有作者归属的 Space 评论和飞书个人表达；
5. AI 推断或低置信度候选。

新证据与旧事实冲突时，保留两边来源并创建待确认状态；不得静默选择较新的文本作为真相。

### 7.3 `space_managed` 的迁移

现有 `founder_topic_visibility='space_managed'` 会隐藏主题。新方案中“由 Space 管理”不应等于“不展示”。

建议：

- `founder_topic_visibility` 只负责显式展示／隐藏；
- `project_space_bindings.management_mode` 负责来源归属；
- 试点同步和内容核验通过后，针对绑定项目单独把旧 `space_managed` 隐藏策略迁回 visible；
- 这是生产数据修改，必须在部署变更单中列出精确 topic、preview、expected version、回滚和断言，不能由 migration 扫描名称自动修改。

## 8. Founder 分析与工作地图改造

### 8.1 扩展允许的来源

修改 `src/ports/founder-stream-analyzer.ts`：

- `sourceType` 增加 `space_page_snapshot`、`space_page_comment`；
- 保持 schema strict、大小限制、content hash 和 excerpt grounding；
- 不把 Page 的共享编辑事实推断为所有成员共同确认。

修改 `src/services/founder-stream-worker.ts`：

- Space ingest 成功后，以稳定 source set enqueue 分析 job；
- 允许 Space 来源通过 eligibility 检查；
- Page 正文与评论分开传给分析器；
- 不把 Space 同步消息当成飞书 feedback，也不进入群聊语料计数；
- 同一 content hash 不重复分析；失败进入可重试状态并保留 gap。

如复用现有 `analyze_founder_stream_batch`，需要扩展 job payload 的作用域，使其能绑定 `projectKey` 而不伪造 `chatId`。不要把 Space 来源挂到批准飞书群 ID 下以绕过安全校验。

### 8.2 合并到当前地图

修改 `src/services/current-founder-work-map.ts` 和 `src/services/founder-manual-query.ts`：

- canonical topic 仍是工作地图的唯一展示对象；
- Space 来源通过 evidence／perspective 更新已有 topic，而不是额外生成一套“Space 项目卡”；
- 已绑定项目的 Page 更新优先续写对应 canonical topic；
- 页面里出现不属于该项目的内容时，作为 related candidate，不能自动新建立项；
- 保持当前 A/B/C 结构、编号、配色、白板和全文交互不变。

### 8.3 显示双来源新鲜度

当前处理状态只显示飞书。增加：

```text
飞书语料：最后收到 / 最新已分析 / 缺口
Space 页面：最后成功同步 / Page 更新时间 / 待处理 / 缺口
```

规则：

- `查看工作地图` 读取 Context 当前状态，不临时抓取 Space，也不无限等待外部同步。
- Space 超过阈值未同步时，地图仍可生成，但必须显示“Space 内容可能滞后”。
- 默认建议 `SPACE_SYNC_STALE_AFTER_MINUTES=30`，生产值在变更单中确认。
- 如果将来存在可靠的 producer 控制通道，可以在查询时发出 refresh request；没有控制通道时不能显示“正在实时刷新”。

## 9. 自动触发条件

按以下优先级验证，不要先假定任何一种已经可用。

### T1｜Page 事件触发（目标方案）

验证 Pages auto-update／automation 是否能在以下事件触发：

- Page 正文发生变化；
- 新评论或评论回复；
- 评论 thread resolved／reopened。

还必须验证该 automation runtime 是否能向 Bridge 发送带自定义 HMAC header 的 HTTPS 请求。只有两个条件都满足，才能采用事件推送。

### T2｜定时增量同步（可靠回退）

若没有可用事件或无法安全调用 Bridge，使用一个**确实拥有 Pages connector 的执行环境**每 10–15 分钟：

1. 读取 active bindings；
2. 只读取登记 Page；
3. 比较 Page sequence／hash 和评论 message IDs；
4. 无变化则不发送；
5. 有变化则生成 envelope 并提交；
6. 记录成功游标；失败保留旧游标并重试。

本地定时任务依赖机器在线，必须在状态中标为 local runtime，不能包装成云端持续可用。

### T3｜手动补偿

提供“同步项目页面”或等价 CLI，用于首次试点、权限恢复和漏同步补偿。手动补偿仍使用同一 envelope、签名、幂等和审计路径，不能写一条直连数据库的旁路脚本。

### T4｜不可接受的方式

- 浏览器 DOM 抓取或保存 Cookie；
- 把 Page 全文复制进飞书群当自动同步；
- 让飞书查询请求等待一个不确定的 Space 页面读取；
- 将 Page title 作为项目唯一匹配依据；
- 因 connector 不可用而把 coverage 写成 complete。

## 10. 分阶段实施步骤

### Phase 0｜能力验证与冻结接口

1. 读取项目 `AGENTS.md`、`MEMORY.md` 和本文件。
2. 核对 Pages reader 可用工具：Page 正文、分页、comments、作者、thread state、sequence／updatedAt。
3. 核对 automation 的触发器和外部 HTTPS 能力。
4. 输出能力矩阵：supported / unsupported / unverified。
5. 无 Pages 权限时继续完成 Bridge contract、fixture 和测试，不尝试绕过权限。

交付：`docs/...-space-sync-capability-matrix.md`。

### Phase 1｜本地 schema、contract 与安全入口

1. 先写迁移和 repository 红灯测试。
2. 新增 `project_space_bindings`、`founder_topic_project_bindings`、`space_sync_runs`。
3. 更新 Drizzle schema 与原生 migration，保持名称和约束完全一致。
4. 实现 `SpaceSyncEnvelopeV1` 严格校验、HMAC、时间窗、replay protection、allowlist 和 body limits。
5. 实现事务性 Context source 写入和 coverage／gap。
6. 增加 `space-sync:import` fixture CLI；该 CLI 走同一 domain service，不绕过验证逻辑。

建议文件：

- `src/domain/space-sync.ts`
- `src/repositories/space-sync-repository.ts`
- `src/services/space-sync-ingestion.ts`
- `src/routes/space-sync.ts`
- `src/cli/import-space-sync.ts`
- 对应 `tests/*space-sync*.test.ts`

### Phase 2｜分析接入

1. 扩展 source type 和 evidence locator。
2. 扩展 durable job，使 Space source 能独立于飞书 chat scope 排队。
3. 将 Page 正文、评论、resolved 状态和作者语义加入 Codex prompt。
4. 复用现有 topic／perspective／alignment reconciliation。
5. 人工绑定 Smart Listing canonical topic；不自动按标题猜测。
6. 验证 Page 内容更新现有项目，不新建重复项目。

### Phase 3｜fixture 端到端与隔离试点

至少准备这些 fixture：

1. Page 正文更新项目阶段和下一步；
2. Ivy 评论提出修正；
3. James 评论表达不同理解；
4. 评论被 resolved，但未形成显式共同决定；
5. 同一 envelope 重放；
6. Page 第二版本；
7. 评论分页不完整；
8. Page permission lost；
9. 未登记 Page；
10. Space 内容与飞书既有状态冲突。

在隔离数据库验证：

- 没有重复 source、topic 或 perspective；
- 评论不变成共识；
- 冲突被展示为待确认；
- 工作地图 A/B/C 和现有编号规则不变；
- Space 新鲜度和 gap 正确；
- 没有 outbox 群消息；
- 不执行 Todo。

### Phase 4｜真实 Page 只读试点

1. 验证候选 Smart Listing Page 的权限、Page ID、标题和归属。
2. 读取正文和评论，先只生成本地 envelope 和隐去正文的统计报告。
3. 在隔离数据库／生产一致性副本上 ingest，不访问生产数据库。
4. 生成“飞书-only vs 飞书+Space”的工作地图对照。
5. Ivy review 项目归属、状态、评论归因和分歧判断。

本阶段不向飞书发消息、不改生产、不启用定时任务。

### Phase 5｜生产 shadow rollout（需单独变更单批准）

建议三个独立 feature flags：

```text
SPACE_SYNC_INGEST_ENABLED=false
SPACE_SYNC_ANALYSIS_ENABLED=false
SPACE_SYNC_WORKMAP_ENABLED=false
```

依次开启：

1. ingest：只接收和审计 Space 来源；
2. analysis：生成候选但不改变工作地图；
3. workmap：试点项目进入真实查询投影。

每一步都需核对数据库、队列、缺口、Codex 登录、API Key fallback=0、group delivery=false，并保留数据库备份、app checkpoint、旧镜像和回滚命令。

### Phase 6｜自动化上线（需确认 producer 运行环境）

在 T1/T2 中选择已验证方案。先只同步一个 Page，连续运行至少两个正常周期和一个无变化周期，再扩展登记表。不要一次扫描整个 Space。

## 11. 测试与验收标准

### Schema／repository

- migration 可重复执行；Drizzle 与 SQL 一致；旧数据库无破坏升级。
- binding、topic binding、sync run 的唯一约束和 FK 生效。
- 相同 Page 内容哈希不新增版本；内容变化只新增一个版本。

### 安全入口

- 签名错误、过期、重放、未知 Page、项目不匹配、超限一律 fail closed。
- 日志不包含正文、评论正文、HMAC secret 或用户凭据。
- ingest 不创建飞书 outbox，不触发 Todo。

### 内容语义

- Page 正文标为项目维护陈述。
- 评论始终保留作者；不同作者不能合并成“团队认为”。
- resolved comment 不自动变成 `shared_decision`。
- 沉默不视为同意。
- 冲突保留双方来源和待确认状态。

### 工作地图

- Smart Listing 不重复创建。
- Space-managed 项目能按明确策略重新显示。
- A/B/C 结构、白板、全文、配色池和纠正入口保持不变。
- 显示飞书与 Space 各自的最后成功时间、待处理和缺口。
- Space stale 时明确标记，不谎称覆盖到查询时刻。

### 完整门禁

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

完成前还要运行相关 targeted tests、fixture E2E，以及生产一致性副本上的只读地图生成。不得用新增测试通过替代完整回归。

## 12. 运行与失败处理

- Page 无权访问：binding 标记 `permission_lost`，写 gap，保留历史内容和地图项目。
- Page 删除：source availability 标记 deleted；不自动删除项目。
- 评论读取不完整：coverage partial；不根据缺失评论判断无分歧。
- producer 离线：显示最后成功同步时间和 stale，不影响飞书已有查询可用性。
- Bridge ingest 失败：producer 使用同一 `syncId` 安全重试；未知提交结果先查 receipt，不生成新 ID 重放。
- 分析失败：来源已持久化，job 可重试；不回滚已验证的 source capture。
- 映射不确定：进入待确认，不按相似名称自动绑定。

## 13. 数据和权限边界

- 只读取项目登记表中的 Page。
- Space 页面和评论包含团队内容；首次真实读取、启用定时任务、创建 HMAC secret、开放生产入口、数据库 migration、部署和重启必须写入生产变更单并取得 Ivy 明确授权。
- 本交接文件授权 Cloud Code 进行本地设计、fixture、测试和候选实现；它不是生产部署授权，也不是全 Space 扫描授权。
- raw Space 文本保留期必须在生产变更单中明确。默认先与现有 Context 原文 retention 对齐；未确认前不要设为永久保存。
- 凭据只记录存放位置，不记录值；不得把 Pages connector token 或 ChatGPT 登录态导出给 Bridge。

## 14. Cloud Code 的具体执行清单

1. 在 `.worktrees/main-merge` 工作，不要在旧根目录业务代码上实施。
2. 忽略现有未跟踪 `.DS_Store`，不要删除或提交。
3. 先完成 Phase 0 能力矩阵和 Phase 1 红灯测试。
4. 复用 `ContextSourceRepository` 的 logical key／hash／version 机制。
5. 不新建第二套项目事实库。
6. 对 Founder analyzer、job scope 和 evidence locator 的扩展先写测试。
7. 以 Smart Listing fixture 完成完整本地 E2E。
8. 若执行环境没有 Pages connector，使用符合真实 schema 的 fixture 完成 Bridge 侧，不尝试网页抓取；把 live producer 标为 blocked prerequisite。
9. 真实 Page 读取前输出准确读取范围和权限说明。
10. 生产前另写变更单，包含权限、Page allowlist、retention、备份、rollback、feature flags、probe、shadow metrics 和唯一一次人工验收。

建议使用的技能／工作方式：

- `superpowers:test-driven-development`
- `superpowers:systematic-debugging`
- `superpowers:verification-before-completion`
- `review`（完成候选后做 landing 前复核）

## 15. 最终用户体验

同步上线后，团队使用方式应保持简单：

1. 在 Space Page 中继续维护单个项目和发表评论。
2. Space 同步器自动把变化沉淀为可追溯 Context。
3. 用户在飞书发送 `查看工作地图`，看到飞书与 Space 合并后的跨项目总览。
4. 用户发送 `查看项目进展：Smart Listing`，看到当前阶段、已完成、待推进、卡点以及来源新鲜度。
5. 用户发送 `查看分歧：Smart Listing`，看到双方当前表达、已有共识、未解决评论和待决定问题。
6. 项目事实应在 Space 修订；跨项目归类和工作地图纠错仍可回复飞书工作地图卡片。两种入口都进入同一事实账本，并保留各自来源。

成功标准不是“机器人能打开 Space 网页”，而是：**任何进入工作地图的结论都能指出来自飞书还是 Space、由谁表达、截至什么时间、是否完整，以及它是个人理解、项目维护陈述还是已确认共识。**

