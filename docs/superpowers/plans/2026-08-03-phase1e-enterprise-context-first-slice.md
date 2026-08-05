# Phase 1E Enterprise Context First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不回归 Phase 1D 项目化 follow-up 的前提下，让一份飞书妙记产生 source-neutral、带原文证据的 Context candidates，并由 Ivy 审核后创建或版本化正式 Context Record。

**Architecture:** 保留现有 `process_minute` 总结链路；在 normalized transcript 后用独立小事务保存不可变 source 并入队 `extract_context_candidates` job，然后继续原有总结事务。候选、证据、审核、正式 record/version 使用 additive SQLite schema；审核入口为 Ivy 私聊 interactive card，所有升格在单一 SQLite transaction 中完成。

**Tech Stack:** Node.js 20+、TypeScript、Fastify、Zod、better-sqlite3/Drizzle schema declaration、飞书官方 Node SDK、服务器本地 Codex CLI；不增加外部数据库、队列、向量库或 OpenAI API。

## Global Constraints

- 本计划在 Ivy Review 并明确授权实施前不得执行。
- 不部署、不访问生产、不修改生产数据或配置、不启动飞书群历史 Context Sync。
- 不读取历史群聊；`PROJECT_CONTEXT_SYNC_ENABLED` 必须保持 `false`。
- 不修改现有 `meeting_summaries`、`meeting_todos`、Project Registry 或 Todo 授权的既有语义。
- 原始来源、AI candidate、review、正式 Context 和 follow-up 必须是不同对象与状态机。
- 无 evidence 不得批准；无 Ivy review 不得创建正式 Context；冲突不得静默覆盖。
- `approved` 不等于 `evidence_verified`；口头进展默认保持 `reported`。
- 所有 AI 工作只通过本地 Codex CLI；不增加 API Key fallback 或隐藏按量调用。
- schema/migration 只做 additive 变更；不提供 destructive down migration。
- 新功能由 `CONTEXT_CANDIDATES_ENABLED=false`、`CONTEXT_REVIEW_ENABLED=false` 默认关闭。
- 当前用户未提交的 `AGENTS.md`、`MEMORY.md`、`docs/feishu-codex-ivy-workflow.html` 不得被覆盖或纳入实现提交。
- 每个任务先写失败测试，再做最小实现；每个任务完成后运行相关测试，最终运行完整 gate。
- 任何 commit、push、部署都需要 Ivy 对实施阶段的明确授权；本计划本身不授权这些动作。

---

## File Structure

### New production files

- `src/domain/context.ts`：Context 核心枚举、Zod schemas 和 TypeScript types；不含 Feishu/Codex 字段。
- `src/ports/json-executor.ts`：现有会议 summarizer 与新 Context extractor 共用的 provider-neutral JSON executor port。
- `src/ports/context-candidate-extractor.ts`：source-neutral candidate extractor port 和输出 schema parser。
- `src/adapters/codex-context-candidate-extractor.ts`：Codex JSON schema、prompt 和 evidence locator 输出。
- `src/repositories/context-source-repository.ts`：source、source relation、evidence、extraction run 的幂等持久化。
- `src/repositories/context-candidate-repository.ts`：candidate、project mapping、evidence、suggested record relation 的持久化与查询。
- `src/repositories/context-record-repository.ts`：review、promotion、logical record、immutable version 和 relation 的事务方法。
- `src/services/context-source-capture.ts`：把 `MinuteContext` 转成完整规范化 transcript source snapshot。
- `src/services/context-candidate-worker.ts`：处理 `extract_context_candidates` durable job，调用 extractor、校验证据并保存候选。
- `src/services/context-review-renderer.ts`：生成 Context Review Card，不包含可被客户端信任的正文状态。
- `src/services/context-review.ts`：校验 Ivy 身份、card action、review CAS 和 promotion intent。
- `src/services/context-promotion.ts`：根据 approved review 创建/更新 record version，写 evidence/relation。
- `src/routes/context-review-actions.ts`：飞书 card action callback route。
- `src/routes/context-diagnostics.ts`：只读聚合和受控 provenance 查询。
- `src/composition/context-runtime.ts`：组合 extractor、repositories、review/promotion services。

### Modified production files

- `src/db/schema.ts`：声明 Phase 1E additive tables 和 CHECK/UNIQUE/FK constraints。
- `src/db/migrate.ts`：创建新表/index；反复运行幂等，不覆盖人工状态。
- `src/config.ts`：加入两个默认 false 的 Context feature flags。
- `src/adapters/codex-summarizer.ts`：只把 `CodexJsonExecutor` import 改到共享 port；现有 prompt/output schema 不变。
- `src/repositories/job-repository.ts`：把 `DurableJob` 改为 discriminated union，增加 context extraction job enqueue/lease/normalization。
- `src/services/job-consumer.ts`：继续保持单 consumer；不增加并发。
- `src/composition/worker-runtime.ts`：按 job kind 路由 `process_minute` 与 `extract_context_candidates`。
- `src/services/meeting-worker.ts`：capture source，并在现有 summary transaction 中幂等 enqueue context job；summary 路径不等待 extractor。
- `src/repositories/outbox-repository.ts`：把 payload 改为 `ivy_meeting_summary | ivy_context_review` union，分别查询/ack。
- `src/adapters/feishu.ts`：投递 review card，并回写真实 message ID。
- `src/routes/feishu-events.ts`：保持消息事件路径；card action 使用独立 route，复用 decrypt/verification helpers 时抽成私有模块。
- `src/app.ts`：条件注册 diagnostics 与 review route。
- `src/server.ts`：组装 Context runtime；feature flags 关闭时不调用 extractor/发送 review。
- `deploy/bridge.env.example`：增加两个默认 false 开关。
- `docs/tencent-cloud-deployment.md`：记录未来变更单、备份和 feature-flag rollout；不表示已部署。

### New tests

- `tests/context-domain.test.ts`
- `tests/context-migrate.test.ts`
- `tests/context-source-repository.test.ts`
- `tests/context-candidate-repository.test.ts`
- `tests/context-record-repository.test.ts`
- `tests/context-source-capture.test.ts`
- `tests/codex-context-candidate-extractor.test.ts`
- `tests/context-candidate-worker.test.ts`
- `tests/context-review-renderer.test.ts`
- `tests/context-review-actions.test.ts`
- `tests/context-promotion.test.ts`
- `tests/context-diagnostics.test.ts`
- `tests/phase1e-context-loop.integration.test.ts`

### Existing regression tests to modify

- `tests/migrate.test.ts`
- `tests/meeting-worker.test.ts`
- `tests/job-consumer.test.ts`
- `tests/worker-runtime-composition.test.ts`
- `tests/outbox-repository.test.ts`
- `tests/feishu-adapters.test.ts`
- `tests/feishu-events-route.test.ts`
- `tests/config.test.ts`
- `tests/deploy-contract.test.ts`
- `tests/project-aware-followups.integration.test.ts`

---

### Task 1: Lock the source-neutral domain and additive SQLite schema

**Deliverable:** 空库和 Phase 1D legacy DB 都能得到一致的 Phase 1E schema；旧表、seed 状态和数据不变。

**Files:**

- Create: `src/domain/context.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Create: `tests/context-domain.test.ts`
- Create: `tests/context-migrate.test.ts`
- Modify: `tests/migrate.test.ts`

**Interfaces:**

```ts
export type ContextCandidateType =
  | 'proposal' | 'decision' | 'reported_progress' | 'claim'
  | 'risk' | 'blocker' | 'requirement' | 'status_update' | 'action_item';

export type ContextScope = 'company' | 'project';
export type ContextFactualStatus =
  | 'source_attested' | 'reported' | 'reviewer_confirmed'
  | 'evidence_verified' | 'disputed';
export type ContextReviewStatus =
  | 'pending' | 'approved' | 'rejected' | 'needs_clarification' | 'conflict';
export type ContextRelationType =
  | 'supplements' | 'confirms' | 'corrects'
  | 'supersedes' | 'conflicts_with' | 'duplicates';
export type ContextEvidenceLevel =
  | 'derived_summary' | 'primary_statement'
  | 'authoritative_record' | 'direct_observation';
export type ContextEvidenceRole = 'supporting' | 'contradicting' | 'context';
export type ContextSourceRelationType = 'derived_from' | 'part_of' | 'revises';
export type ContextExtractionSourceRole = 'primary' | 'context';
```

Tables created by `migrationSql` and mirrored by Drizzle declarations:

1. `context_sources`
2. `context_source_relations`
3. `context_evidence`
4. `context_extraction_runs`
5. `context_extraction_run_sources`
6. `context_candidates`
7. `context_candidate_projects`
8. `context_candidate_evidence`
9. `context_candidate_record_relations`
10. `context_reviews`
11. `context_records`
12. `context_record_versions`
13. `context_record_projects`
14. `context_record_evidence`
15. `context_record_relations`

Required constraints:

- `context_sources UNIQUE(logical_key, content_hash)`;
- `context_evidence UNIQUE(source_id, excerpt_hash, locator_json)`;
- `context_extraction_runs UNIQUE(source_set_hash, extractor_name, extractor_version, prompt_version)`;
- `context_candidates UNIQUE(candidate_fingerprint)`;
- `context_candidates.extraction_confidence CHECK 0 <= value <= 1`;
- candidate/record enum columns use explicit CHECK constraints matching `src/domain/context.ts`;
- `context_record_versions UNIQUE(record_id, version_number)`;
- `context_reviews.idempotency_key UNIQUE`;
- project FKs reference existing `projects(project_key)`;
- relation tables use composite UNIQUE constraints to block duplicate edges.

- [ ] **Step 1: Write domain enum/schema tests**

Test valid values and rejection of unknown candidate type, `task` scope, out-of-range confidence, and invalid relation. Include a test proving `approved` and `evidence_verified` are independent fields.

- [ ] **Step 2: Run the domain test and verify failure**

Run: `pnpm exec vitest run tests/context-domain.test.ts`  
Expected: FAIL because `src/domain/context.ts` does not exist.

- [ ] **Step 3: Implement `src/domain/context.ts`**

Use Zod enums and object schemas. Export inferred types and parsers. Keep JSON payload fields as `z.record(z.string(), z.unknown())`; do not add provider fields.

- [ ] **Step 4: Write migration tests against empty and legacy databases**

Assertions must inspect `sqlite_master`, `PRAGMA table_info`, `PRAGMA foreign_key_list` and unique indexes. The legacy test must seed an archived project and disabled mapping rule, run migration twice, and prove both remain unchanged.

- [ ] **Step 5: Run migration tests and verify failure**

Run: `pnpm exec vitest run tests/context-migrate.test.ts tests/migrate.test.ts`  
Expected: FAIL because Phase 1E tables do not exist.

- [ ] **Step 6: Add Drizzle declarations and raw SQL migration**

Add all 15 tables without altering existing Phase 1D columns. Use `CREATE TABLE/INDEX IF NOT EXISTS`. Do not seed Context records or candidates.

- [ ] **Step 7: Run Task 1 tests**

Run: `pnpm exec vitest run tests/context-domain.test.ts tests/context-migrate.test.ts tests/migrate.test.ts tests/meeting-repository.test.ts tests/project-repository.test.ts`  
Expected: PASS.

- [ ] **Step 8: Review gate**

Inspect `git diff -- src/domain/context.ts src/db/schema.ts src/db/migrate.ts tests/` and confirm no existing table was dropped, renamed, rebuilt or seeded with formal Context.

---

### Task 2: Add idempotent source, evidence, candidate and record repositories

**Deliverable:** 核心 provenance 和 version 操作在 SQLite transaction 中可独立验证，不依赖 Feishu 或 Codex。

**Files:**

- Create: `src/repositories/context-source-repository.ts`
- Create: `src/repositories/context-candidate-repository.ts`
- Create: `src/repositories/context-record-repository.ts`
- Create: `tests/context-source-repository.test.ts`
- Create: `tests/context-candidate-repository.test.ts`
- Create: `tests/context-record-repository.test.ts`
- Create: `tests/context-promotion.test.ts`

**Interfaces:**

```ts
export interface SaveContextSourceInput {
  sourceSystem: string;
  sourceType: string;
  externalId: string;
  logicalKey: string;
  occurredAt: string;
  authors: readonly Record<string, unknown>[];
  locatorUri: string | null;
  contentFormat: string;
  contentText: string;
  metadata: Record<string, unknown>;
  availabilityStatus: 'available' | 'deleted' | 'permission_lost' | 'unknown';
  capturedAt: Date;
}

export interface SaveEvidenceInput {
  sourceId: string;
  excerpt: string;
  locator: Record<string, unknown>;
  evidenceLevel: ContextEvidenceLevel;
  capturedAt: Date;
}

export interface BeginExtractionRunInput {
  sources: readonly { id: string; contentHash: string }[];
  extractorName: string;
  extractorVersion: string;
  promptVersion: string;
  startedAt: Date;
}

export interface SaveContextCandidateInput {
  extractionRunId: string;
  candidateType: ContextCandidateType;
  scope: ContextScope;
  summary: string;
  subjectKey: string | null;
  structuredPayload: Record<string, unknown>;
  extractionConfidence: number;
  factualStatus: 'source_attested' | 'reported';
  projects: readonly CandidateProjectInput[];
  evidence: readonly CandidateEvidenceInput[];
  suggestedRelations: readonly CandidateRecordRelationInput[];
  externalRefs: readonly Record<string, unknown>[];
}
```

Repository rules:

- source ID is deterministic from logical key + content hash;
- evidence ID is deterministic from source + canonical locator + excerpt hash;
- extraction run returns `{created, run}` and reuses identical runs;
- candidate fingerprint does not include displayed order or model prose outside normalized atomic summary;
- repository rejects candidate with zero supporting evidence;
- project-scoped candidate requires exactly one primary mapped project before approval, not necessarily before pending persistence;
- context record repository never updates an existing version body;
- promotion creates review + record/version + project/evidence/relation in one transaction.

- [ ] **Step 1: Write source/evidence idempotency tests**

Save the same source and evidence twice and assert one row; change content and assert a new source snapshot with the same logical key; mark the external source deleted and assert snapshot/excerpt remain.

- [ ] **Step 2: Run source tests and verify failure**

Run: `pnpm exec vitest run tests/context-source-repository.test.ts`  
Expected: FAIL because repository is missing.

- [ ] **Step 3: Implement source/evidence/extraction run repository**

Use canonical JSON serialization for hash inputs: recursively sorted object keys, array order preserved, UTF-8 SHA-256. Never log content text or excerpts.

- [ ] **Step 4: Write candidate persistence tests**

Cover candidate fingerprint idempotency, multiple evidence, multiple related projects, separate mapping/extraction confidence, and rejection of evidence locators that do not belong to extraction run sources.

- [ ] **Step 5: Implement candidate repository**

Persist candidate and all relation rows in one transaction. On fingerprint conflict, return the existing candidate without changing review state.

- [ ] **Step 6: Write record/version/promotion tests**

Cover create v1, supplements v2, corrects v3, supersedes, confirms, duplicates without a new version, conflict without overwrite, duplicate review callback, non-Ivy rejection, and transaction rollback on relation constraint failure.

- [ ] **Step 7: Implement record repository transaction methods**

Expose one promotion entry point:

```ts
promoteCandidate(input: {
  candidateId: string;
  expectedReviewStatus: 'pending' | 'needs_clarification' | 'conflict';
  reviewerOpenId: string;
  action: 'approve' | 'reject' | 'request_clarification' | 'mark_conflict';
  approvedSummary?: string;
  approvedPayload?: Record<string, unknown>;
  decidedFactualStatus?: ContextFactualStatus;
  targetRecordId?: string;
  relationType?: ContextRelationType;
  reason?: string;
  idempotencyKey: string;
  reviewedAt: Date;
}): ContextReviewResult;
```

Only `approve` may create a version. `duplicates` must not create one. `conflicts_with` must keep candidate/record disputed and must not supersede content.

- [ ] **Step 8: Run Task 2 tests**

Run: `pnpm exec vitest run tests/context-source-repository.test.ts tests/context-candidate-repository.test.ts tests/context-record-repository.test.ts tests/context-promotion.test.ts`  
Expected: PASS.

---

### Task 3: Capture the minute transcript as an immutable source without delaying Phase 1D

**Deliverable:** `process_minute` 成功读取 transcript 后保存完整规范化 source snapshot；Context 功能关闭时不写 source、不入 context job。

**Files:**

- Create: `src/services/context-source-capture.ts`
- Modify: `src/config.ts`
- Modify: `src/services/meeting-worker.ts`
- Modify: `src/repositories/job-repository.ts`
- Modify: `src/db/migrate.ts`
- Modify: `deploy/bridge.env.example`
- Create: `tests/context-source-capture.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/meeting-worker.test.ts`
- Modify: `tests/migrate.test.ts`

**Interfaces:**

```ts
export interface CapturedMinuteSource {
  source: SaveContextSourceInput;
  segmentLocators: readonly {
    segmentOrdinal: number;
    speakerName: string;
    startMs: number;
    endMs: number;
    text: string;
  }[];
}

export function captureMinuteTranscriptSource(
  context: MinuteContext,
  capturedAt: Date
): CapturedMinuteSource;

export type DurableJob = ProcessMinuteJob | ExtractContextCandidatesJob;
export interface ExtractContextCandidatesJob {
  kind: 'extract_context_candidates';
  key: string;
  sourceId: string;
  extractionKey: string;
  attempt: number;
  leaseExpiresAt?: string;
}
```

Canonical transcript format:

```text
speakerName [startMs-endMs]: segment text
```

Metadata contains minute title, started/ended timestamps and ordered segment locators. `logical_key` is `feishu:minute:<minuteId>:transcript`; the core repository does not parse this provider-specific value.

- [ ] **Step 1: Write config tests**

Assert both flags default false, parse only `true/false`, and appear in private `AppConfig` but not in `PublicConfig` if exposing them would add no diagnostic value.

- [ ] **Step 2: Write source capture tests**

Use a multi-speaker `MinuteContext`; assert deterministic content, hash input, segment ordinals, source type, and that transcript text is not lost.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm exec vitest run tests/config.test.ts tests/context-source-capture.test.ts`  
Expected: FAIL because flags/service are missing.

- [ ] **Step 4: Implement config and source capture**

Add:

```env
CONTEXT_CANDIDATES_ENABLED=false
CONTEXT_REVIEW_ENABLED=false
```

Do not alter `PROJECT_CONTEXT_SYNC_ENABLED` or its approved chat restrictions.

- [ ] **Step 5: Write job union and meeting worker regression tests**

Tests must prove:

- context disabled: no source and no extraction job;
- context enabled: source saved once and `context-extract:<sourceId>:<extractorVersion>:<promptVersion>` enqueued once;
- summary/outbox body and `minute-summary:<minuteId>` key remain unchanged;
- source save/extraction enqueue replay does not duplicate;
- context capture/enqueue 出现 Context 专用 validation failure 时，记录脱敏 typed failure 并继续 existing summary；数据库整体不可写时仍按现有 worker 失败语义处理。

- [ ] **Step 6: Implement source capture and enqueue boundary**

After reader validation, save source and enqueue extraction in one small Context transaction, then continue the existing summarizer and summary/Todo/outbox transaction unchanged. Because the consumer remains serial, the normal path finishes `process_minute` before leasing the newly queued Context job. A crash can leave either job to recover independently; replay must ensure both source and extraction job exist without duplicating either.

- [ ] **Step 7: Run Task 3 tests and Phase 1D regression**

Run: `pnpm exec vitest run tests/context-source-capture.test.ts tests/config.test.ts tests/meeting-worker.test.ts tests/minute-ingestion.test.ts tests/project-aware-followups.integration.test.ts`  
Expected: PASS.

---

### Task 4: Extract atomic candidates in an independent durable job

**Deliverable:** Context job 从持久化 source 生成通过 Zod/JSON Schema/evidence 校验的 candidates；失败不影响 summary。

**Files:**

- Create: `src/ports/context-candidate-extractor.ts`
- Create: `src/ports/json-executor.ts`
- Create: `src/adapters/codex-context-candidate-extractor.ts`
- Modify: `src/adapters/codex-summarizer.ts`
- Create: `src/services/context-candidate-worker.ts`
- Create: `src/composition/context-runtime.ts`
- Modify: `src/repositories/job-repository.ts`
- Modify: `src/services/job-consumer.ts`
- Modify: `src/composition/worker-runtime.ts`
- Modify: `src/server.ts`
- Create: `tests/codex-context-candidate-extractor.test.ts`
- Create: `tests/context-candidate-worker.test.ts`
- Modify: `tests/job-consumer.test.ts`
- Modify: `tests/worker-runtime-composition.test.ts`

**Interfaces:**

```ts
export interface ContextCandidateExtractorOutput {
  candidates: Array<{
    candidateType: ContextCandidateType;
    scope: ContextScope;
    summary: string;
    subjectKey: string | null;
    structuredPayload: Record<string, unknown>;
    extractionConfidence: number;
    factualStatus: 'source_attested' | 'reported';
    projectMappings: Array<{
      projectKey: string | null;
      role: 'primary' | 'related';
      confidence: 'high' | 'medium' | 'low';
      evidence: string;
    }>;
    evidence: Array<{
      sourceId: string;
      excerpt: string;
      locator: Record<string, unknown>;
      evidenceLevel: 'primary_statement' | 'derived_summary';
      role: ContextEvidenceRole;
    }>;
    suggestedRelations: Array<{
      recordId: string;
      relationType: ContextRelationType;
      rationale: string;
    }>;
    externalRefs: Array<Record<string, unknown>>;
  }>;
}

export interface ContextCandidateExtractor {
  extract(input: {
    sources: readonly ContextSourceRecord[];
    projects: readonly ProjectContextCard[];
    existingRecords: readonly ContextRecordSummary[];
  }): Promise<ContextCandidateExtractorOutput>;
}
```

Prompt rules must include the nine candidate types, atomic split rule, factual defaults, evidence excerpt requirement, project mapping separation, relation semantics, maximum 12 candidates, and the explicit example separating “决定上线” from “已经上线”。

- [ ] **Step 1: Write JSON schema and prompt contract tests**

Assert output schema has no provider-specific fields; rejects `reviewer_confirmed/evidence_verified`, missing evidence, more than 12 candidates, invalid relation and project scope without a primary project proposal.

- [ ] **Step 2: Run extractor tests and verify failure**

Run: `pnpm exec vitest run tests/codex-context-candidate-extractor.test.ts`  
Expected: FAIL because extractor does not exist.

- [ ] **Step 3: Implement port, JSON schema and Codex adapter**

Move the existing `CodexJsonExecutor` interface unchanged from `src/adapters/codex-summarizer.ts` to `src/ports/json-executor.ts`; import it from both summarizers. Do not change the existing meeting prompt/output schema or any CLI flag. The new adapter must not call OpenAI API directly.

- [ ] **Step 4: Write candidate worker tests**

Cover completed run, same job replay, invalid excerpt, candidate with no evidence, low project confidence, extraction output invalid, lease lost before persistence, Codex timeout retry budget, and permanent failure after budget exhaustion.

- [ ] **Step 5: Implement candidate worker**

Worker sequence:

1. validate leased job;
2. load source and begin/reuse extraction run;
3. load active projects and bounded existing record summaries;
4. call extractor outside DB transaction;
5. validate every excerpt against source content/locator;
6. in one transaction recheck lease, save evidence/candidates/relations, mark run completed, enqueue review outbox if enabled;
7. mark job completed with lease CAS.

Do not call `renderMeetingSummary` or write meeting tables.

- [ ] **Step 6: Generalize job leasing without adding concurrency**

Replace `leaseNextProcessMinute` at composition boundary with `leaseNextSupportedJob`, preserving oldest-created ordering and current lease rules. `DurableJobConsumer` remains one-at-a-time. Invalid payloads fail closed by job kind.

- [ ] **Step 7: Run Task 4 tests**

Run: `pnpm exec vitest run tests/codex-context-candidate-extractor.test.ts tests/context-candidate-worker.test.ts tests/job-consumer.test.ts tests/worker-runtime-composition.test.ts tests/meeting-worker.test.ts`  
Expected: PASS.

---

### Task 5: Deliver a private Context Review Card and expose safe diagnostics

**Deliverable:** Ivy 能看到带类型、项目、事实状态和原文片段的待审核卡片；公网 diagnostics 不泄漏正文。

**Files:**

- Create: `src/services/context-review-renderer.ts`
- Create: `src/routes/context-diagnostics.ts`
- Modify: `src/repositories/outbox-repository.ts`
- Modify: `src/adapters/feishu.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Create: `tests/context-review-renderer.test.ts`
- Create: `tests/context-diagnostics.test.ts`
- Modify: `tests/outbox-repository.test.ts`
- Modify: `tests/feishu-adapters.test.ts`
- Modify: `tests/deploy-contract.test.ts`

**Interfaces:**

```ts
export interface IvyContextReviewMessage {
  kind: 'ivy_context_review';
  extractionRunId: string;
  targetChatId: string;
  card: Record<string, unknown>;
}

export type OutboxMessage = IvyMeetingSummaryMessage | IvyContextReviewMessage;

export interface ContextDiagnostics {
  sources: { total: number; latestCapturedAt: string | null };
  extractionRuns: { processing: number; completed: number; failed: number };
  candidates: {
    pending: number;
    approved: number;
    rejected: number;
    needsClarification: number;
    conflict: number;
  };
  records: { active: number; disputed: number; archived: number };
}
```

Card requirements:

- header 显示会议标题与候选数；
- 每条显示 stable review number、candidate type 中文标签、company/project、project confidence、factual status、summary、evidence excerpt；
- 主操作文案“纳入 Context（保持当前事实状态）”；
- 另有“拒绝”“需要澄清”；
- conflict candidate 不显示覆盖式批准按钮；
- `evidence_verified` 操作只有 direct/authoritative evidence 时出现；
- card action value 只包含 `candidateId/action/expectedReviewStatus/cardNonce`，不包含 summary/payload；
- 最多 12 条，按重要类型排序，不提供“全部批准”。

- [ ] **Step 1: Write renderer tests**

Cover reported progress copy, project confidence, evidence excerpt, conflict behavior, button payload allowlist, card size bound and no secret/source full text.

- [ ] **Step 2: Write outbox union tests**

Assert meeting summary list/delivery remains unchanged; review card uses `context-review:<extractionRunId>` idempotency key; ack binds real message ID without affecting `meeting_summaries`.

- [ ] **Step 3: Implement renderer and outbox union**

Use discriminated payload parsing before delivery. Do not use unsafe `as IvyMeetingSummaryMessage` on all rows.

- [ ] **Step 4: Write diagnostics tests**

Assert aggregate counts and timestamps only. Response must not include `content_text`, `excerpt`, `locator_uri`, `structured_payload`, open IDs, tokens or secrets.

- [ ] **Step 5: Implement `/diag/context`**

Register only when Context runtime repositories are present. Keep endpoint read-only; do not add approval query parameters or mutation methods.

- [ ] **Step 6: Run Task 5 tests**

Run: `pnpm exec vitest run tests/context-review-renderer.test.ts tests/context-diagnostics.test.ts tests/outbox-repository.test.ts tests/feishu-adapters.test.ts tests/project-diagnostics.test.ts`  
Expected: PASS.

---

### Task 6: Accept Ivy review actions and promote records transactionally

**Deliverable:** 只有经过验证的 Ivy callback 能改变 candidate；批准创建/更新正式 version，拒绝/澄清/冲突不创建正式内容。

**Files:**

- Create: `src/services/context-review.ts`
- Create: `src/services/context-promotion.ts`
- Create: `src/routes/context-review-actions.ts`
- Modify: `src/routes/feishu-events.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Create: `tests/context-review-actions.test.ts`
- Modify: `tests/feishu-events-route.test.ts`
- Modify: `tests/context-promotion.test.ts`
- Modify: `tests/context-record-repository.test.ts`

**Interfaces:**

```ts
export interface ContextReviewActionInput {
  candidateId: string;
  action: 'approve_keep_status' | 'approve_verified' | 'reject' | 'needs_clarification' | 'mark_conflict';
  expectedReviewStatus: ContextReviewStatus;
  cardNonce: string;
  operatorOpenId: string;
  callbackChatId: string;
}

export type ContextReviewDecision =
  | { kind: 'approved'; candidateId: string; recordId: string; versionNumber: number }
  | { kind: 'rejected'; candidateId: string }
  | { kind: 'needs_clarification'; candidateId: string }
  | { kind: 'conflict'; candidateId: string }
  | { kind: 'duplicate'; candidateId: string; recordId: string }
  | { kind: 'reject'; reason: string };
```

Security rules:

- decrypt/verify callback using the same configured Feishu verification boundary;
- `operatorOpenId` must start `ou_` and be in `FEISHU_APPROVER_OPEN_IDS`;
- callback chat must equal Ivy private chat if Feishu payload exposes chat; otherwise resolve from stored review outbox message correlation;
- load candidate/body/evidence from DB; never trust card-provided content;
- validate card nonce and actual delivered review message;
- use candidate `review_status` CAS and unique review idempotency key;
- `approve_verified` requires at least one `authoritative_record/direct_observation` supporting evidence;
- candidate project mapping must be resolved before approval;
- conflict cannot select supersede/correct without an explicit second relation choice.

- [ ] **Step 1: Write route/security tests**

Cover invalid encryption/token, missing operator, wrong open ID, wrong chat/message correlation, tampered candidate ID, stale expected status, duplicate callback, pending review message not delivered, and approved happy path.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm exec vitest run tests/context-review-actions.test.ts`  
Expected: FAIL because route/service do not exist.

- [ ] **Step 3: Implement review service and route**

Keep callback parsing separate from domain decision. Return a short safe acknowledgement/card update; do not return source text in HTTP response or log.

- [ ] **Step 4: Write promotion relation tests**

Use a sequence:

1. approve decision → record v1;
2. new evidence confirms → v2 with `confirms`;
3. later status changes → v3 with `supersedes`;
4. correction → v4 with `corrects`;
5. unresolved contradiction → no v5, candidate/record disputed;
6. duplicate → no new version.

Assert all old versions/evidence remain queryable.

- [ ] **Step 5: Implement promotion service**

The service chooses only from review-provided explicit intent. It must not ask the extractor again during promotion. Record/project/evidence/relation writes and candidate status CAS share one transaction.

- [ ] **Step 6: Run Task 6 tests**

Run: `pnpm exec vitest run tests/context-review-actions.test.ts tests/context-promotion.test.ts tests/context-record-repository.test.ts tests/feishu-events-route.test.ts tests/reply-router.test.ts`  
Expected: PASS.

---

### Task 7: Prove the complete local loop, rollback safety and Phase 1D non-regression

**Deliverable:** 一份 fixture 妙记同时完成原有 follow-up 和 Context 候选/审核/版本闭环，且 feature flags 关闭时与 `932be35` 行为等价。

**Files:**

- Create: `tests/phase1e-context-loop.integration.test.ts`
- Modify: `tests/helpers/meeting-loop-fixture.ts`
- Modify: `tests/project-aware-followups.integration.test.ts`
- Modify: `tests/local-startup.test.ts`
- Modify: `tests/deploy-contract.test.ts`
- Modify: `docs/tencent-cloud-deployment.md`
- Create: `docs/phase1e-uat-runbook.md`
- Modify: `MEMORY.md` only after Ivy-approved implementation yields durable decisions or verified UAT facts

**Integration fixture:**

Use one minute with statements equivalent to:

```text
Ivy: 我们决定 Phase 1E 第一版必须人工审核后才能进入正式 Context。
Participant: Context 审核页已经上线。
Ivy: 目前没有部署证据，这只能算口头进展。
Ivy: OpenMontage 的验收清单仍缺少效果指标，这是 blocker。
Ivy: Codex 可以起草验收指标清单。
```

Expected output:

- existing summary still contains project-aware follow-up for OpenMontage;
- candidates include `decision/source_attested`、`reported_progress/reported`、`blocker/reported`、`action_item/source_attested`；
- “审核页已经上线” cannot be `evidence_verified`;
- action item can reference the meeting Todo but has independent status;
- all candidates cite exact transcript excerpts;
- approve decision creates record v1;
- reject reported progress creates no record;
- needs clarification blocker creates no record;
- replay three times creates no duplicate source/run/candidate/review/version/outbox.

- [ ] **Step 1: Write the end-to-end test and verify failure**

Run: `pnpm exec vitest run tests/phase1e-context-loop.integration.test.ts`  
Expected: FAIL until Tasks 1–6 are complete.

- [ ] **Step 2: Extend fixture helpers without changing Phase 1D defaults**

Context dependencies must be optional; existing callers get flags disabled and unchanged result types unless they opt in.

- [ ] **Step 3: Make the integration test pass**

Use fake Feishu reader, fake Codex summary, fake Context extractor, real SQLite/repositories/workers/renderers, and fake delivery/card callback. Do not invoke network or real Codex CLI.

- [ ] **Step 4: Add rollback/feature-flag contract tests**

Assert disabled flags do not register review mutation route, do not enqueue Context jobs and do not send review cards. Existing `/health`, `/ready`, `/diag/projects`, summary delivery and reply routing remain unchanged.

- [ ] **Step 5: Write UAT runbook**

`docs/phase1e-uat-runbook.md` must include preflight, approved production change window, SQLite backup/integrity check, flags rollout, one real meeting, candidate review cases, provenance verification, queue/outbox terminal checks, rollback triggers and explicit prohibition on group history sync.

- [ ] **Step 6: Run complete local gate**

Run:

```sh
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all tests pass; no network calls; no production state changes.

- [ ] **Step 7: Scope and secret audit**

Run:

```sh
git status --short
git diff --stat
rg -n "content_text|excerpt|transcript|open_id|token|secret" src/routes src/services src/repositories
```

Review every log/diagnostic path found. Confirm transcript/excerpt never enters logs or aggregate diagnostics and no credential value is present in diff.

- [ ] **Step 8: Stop for Ivy implementation review**

Report changed files, gate results, schema additions, feature-flag behavior, remaining privacy decision and proposed production change sheet. Do not commit, push or deploy without explicit authorization.

---

## Acceptance Matrix

| Requirement | Test/Task |
|---|---|
| source-neutral core schema | Task 1 domain/migration tests |
| raw source snapshot + exact evidence | Task 2/3 repository and capture tests |
| same minute replay idempotency | Task 2/3/7 |
| independent project/content/factual confidence | Task 1/2/4 |
| candidate types and atomic split | Task 4 extractor tests |
| Phase 1D summary non-regression | Task 3/7 |
| Ivy-only review | Task 6 security tests |
| no approval, no formal record | Task 2/6/7 |
| reported progress not auto-verified | Task 4/6/7 |
| version history and relations | Task 2/6 |
| no silent conflict overwrite | Task 2/6 |
| safe diagnostics | Task 5 |
| flags default off / rollback | Task 3/7 |
| no group history reads | Task 3/7 deploy contract |

## Future Production Rollout Boundary

This plan does not authorize production work. After local implementation and Ivy code/design review, a separate production change sheet must specify:

1. exact approved commit and release hash;
2. SQLite pre/post backups and integrity checks;
3. raw transcript retention/encryption decision;
4. flags initially false, then candidates on, then review on as separate observable steps;
5. queue/outbox preflight and terminal criteria;
6. one real meeting UAT;
7. rollback commands that restore previous image/config without deleting additive tables;
8. explicit confirmation that `PROJECT_CONTEXT_SYNC_ENABLED=false` before and after rollout.

## Self-Review

- Spec coverage: all 15 product questions, five core objects, first source Adapter, review, promotion, conflict, idempotency, rollback and UAT have an owning task.
- Placeholder scan: no implementation placeholder or undefined task reference remains.
- Type consistency: candidate/review/factual/relation enums match the design spec; job and outbox use discriminated unions.
- Scope check: first slice uses only new Feishu minutes; other sources, history sync, auto-approval, search and infrastructure expansion remain excluded.
