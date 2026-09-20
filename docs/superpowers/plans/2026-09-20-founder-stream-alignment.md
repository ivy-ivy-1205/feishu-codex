# Founder Stream Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, production-disabled pipeline that initializes Context from a 20-day Ivy–James Feishu group window, continuously incorporates later group messages and Minutes, discovers projects from evidence, accepts group corrections and emits only action-relevant alignment reminders to the same group.

**Architecture:** Extend the immutable Phase 1E Source/Evidence model to support Feishu group messages and source-specific locators. Add an emergent topic layer between raw Context candidates and the existing Project Registry, then derive projects, founder perspectives and alignment issues from versioned topic state. Historical backfill and live ingestion share one durable processing path; all production reads and sends remain behind default-off flags and explicit operational approval.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, Zod, SQLite/Drizzle-compatible SQL, `better-sqlite3`, Feishu official Node SDK, server-local Codex CLI, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-founder-stream-alignment-design.md`

## Global Constraints

- The only approved source group is `oc_a84d5b6ca478220d0a37964b50776edb`.
- Initial history scope is exactly 20 days, converted to an explicit `since` timestamp at invocation time.
- Fresh databases must contain zero preset projects and zero system keyword mapping rules.
- Existing seeded rows must not be deleted; mark them `legacy_seed` and exclude them from automatic discovery until source evidence or founder correction confirms them.
- Group messages and Feishu Minutes must use the same immutable Source/Evidence pipeline.
- Video and ordinary audio remain skipped; missing voice transcription is an explicit coverage gap.
- No OpenAI API key or direct API fallback is allowed; semantic extraction uses Codex CLI only.
- Historical sync, live founder-stream analysis and group delivery are independently default-off.
- No Todo execution, code execution or external action is added by this plan.
- Production deployment, production database migration, Feishu history reads, env changes, service restart and real group sends require separate Ivy approval.

---

### Task 1: Remove preset project authority without deleting audit history

**Files:**
- Modify: `src/domain/project.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/repositories/project-repository.ts`
- Delete after references are removed: `src/services/project-registry-seed.ts`
- Test: `tests/migrate.test.ts`
- Test: `tests/project-repository.test.ts`

**Interfaces:**
- Produces: `ProjectOrigin = 'discovered' | 'human_confirmed' | 'legacy_seed'`
- Produces: `ProjectStage = 'idea' | 'exploring' | 'project_candidate' | 'active_project' | 'paused' | 'closed'`
- Produces: `ProjectRepository.listDiscoveryEligibleProjects(): ProjectDefinition[]`
- Preserves: existing project rows and mapping rules for audit.

- [ ] **Step 1: Write failing migration tests**

Add tests that assert a fresh database has `0` projects and `0` mapping rules, while a database created with the previous nine seed keys is migrated with `origin='legacy_seed'` and excluded from `listDiscoveryEligibleProjects()`.

```ts
expect(projectRepository.listProjects()).toHaveLength(0);
expect(projectRepository.listMappingRules()).toHaveLength(0);

expect(projectRepository.getProject('openmontage')).toMatchObject({
  origin: 'legacy_seed'
});
expect(projectRepository.listDiscoveryEligibleProjects()).toEqual([]);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm vitest run tests/migrate.test.ts tests/project-repository.test.ts`  
Expected: FAIL because migrations still seed nine projects and the new origin/stage fields do not exist.

- [ ] **Step 3: Add compatible project origin and stage columns**

Add columns with fail-closed defaults and backfill existing rows:

```sql
ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy_seed'
  CHECK(origin IN ('discovered','human_confirmed','legacy_seed'));
ALTER TABLE projects ADD COLUMN stage TEXT NOT NULL DEFAULT 'active_project'
  CHECK(stage IN ('idea','exploring','project_candidate','active_project','paused','closed'));
```

Stop calling `seedProjectRegistry()` for fresh migrations. Do not delete existing rows or correction rules.

- [ ] **Step 4: Add the discovery-eligible repository query**

Implement eligibility as `origin != 'legacy_seed'` and `stage NOT IN ('closed')`. Keep the existing full-list methods for diagnostics and audit.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/migrate.test.ts tests/project-repository.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/domain/project.ts src/db/schema.ts src/db/migrate.ts src/repositories/project-repository.ts src/services/project-registry-seed.ts tests/migrate.test.ts tests/project-repository.test.ts
git commit -m "refactor: remove preset project authority"
```

### Task 2: Generalize immutable evidence for chat messages and Minutes

**Files:**
- Modify: `src/domain/context.ts`
- Modify: `src/repositories/context-source-repository.ts`
- Modify: `src/services/context-evidence-locator.ts`
- Modify: `src/services/context-source-capture.ts`
- Create: `src/services/group-message-source-capture.ts`
- Test: `tests/context-source-repository.test.ts`
- Create: `tests/group-message-source-capture.test.ts`

**Interfaces:**
- Produces: discriminated `ContextEvidenceLocator` with `kind: 'minute_segment' | 'group_message'`
- Produces: `captureGroupMessageSource(message, capturedAt, limits): CapturedGroupMessageSource`
- Preserves: existing minute evidence validation.

- [ ] **Step 1: Write failing locator tests**

Use a group-message locator with stable message and thread identity:

```ts
const locator = {
  kind: 'group_message' as const,
  sourceVersion: 1,
  contentHash,
  chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
  messageId: 'om_1',
  threadId: 'omt_1',
  authorOpenId: 'ou_ivy',
  occurredAt: '2026-09-01T00:00:00.000Z'
};
expect(repository.saveEvidence({ sourceId, excerpt: '先做页面预览', locator,
  evidenceLevel: 'primary_statement', capturedAt })).toMatchObject({ created: true });
```

- [ ] **Step 2: Run focused tests and verify schema rejection**

Run: `pnpm vitest run tests/context-source-repository.test.ts tests/group-message-source-capture.test.ts`  
Expected: FAIL because evidence accepts only transcript locators.

- [ ] **Step 3: Implement the discriminated locator schema**

Keep current timestamp and speaker checks under `kind='minute_segment'`; validate group locators against the stored source metadata, content hash, chat ID and message ID.

- [ ] **Step 4: Implement group source capture**

Use logical key `feishu:chat:<chatId>:message:<messageId>`, author `{ openId, displayName }`, source type `group_message`, and metadata containing `threadId`, `rootId`, `messageType` and stable Feishu locator URL when available.

- [ ] **Step 5: Run focused and regression tests, then commit**

Run: `pnpm vitest run tests/context-source-repository.test.ts tests/group-message-source-capture.test.ts tests/context-evidence-locator.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/domain/context.ts src/repositories/context-source-repository.ts src/services/context-evidence-locator.ts src/services/context-source-capture.ts src/services/group-message-source-capture.ts tests/context-source-repository.test.ts tests/group-message-source-capture.test.ts tests/context-evidence-locator.test.ts
git commit -m "feat: support group message context evidence"
```

### Task 3: Complete the auditable 20-day history reader

**Files:**
- Modify: `src/services/feishu-context-sync.ts`
- Modify: `src/adapters/feishu-sdk.ts`
- Modify: `src/config.ts`
- Create: `src/services/founder-stream-backfill.ts`
- Create: `src/cli/backfill-founder-stream.ts`
- Modify: `package.json`
- Test: `tests/feishu-context-sync.test.ts`
- Create: `tests/founder-stream-backfill.test.ts`

**Interfaces:**
- Produces: `runFounderStreamBackfill({ chatId, since, now, feishu, sourceRepository, jobRepository }): Promise<FounderStreamBackfillReport>`
- Produces CLI: `pnpm founder-stream:backfill -- --chat-id <id> --since <ISO> --dry-run`
- Enqueues: stable `analyze_founder_stream_batch` jobs only when `--dry-run` is absent.

- [ ] **Step 1: Write failing pagination, thread and exact-window tests**

Assert the caller passes an explicit `since` equal to `now - 20 days`; the service must not compute an implicit 30-day default. Assert root pages and discovered thread IDs are separately paged and recorded in coverage.

```ts
expect(report.requestedRange).toEqual({
  since: '2026-08-31T00:00:00.000Z',
  until: '2026-09-20T00:00:00.000Z'
});
expect(report.coverage.rootPages).toBe(2);
expect(report.coverage.threadPages).toBe(3);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/feishu-context-sync.test.ts tests/founder-stream-backfill.test.ts`  
Expected: FAIL because thread pagination, source persistence and the CLI runner are absent.

- [ ] **Step 3: Extend the SDK boundary for thread pagination**

Add `listThreadMessages({ threadId, cursor, since })`; capture `sender_id`, `thread_id`, `root_id`, `parent_id`, edit/delete status and message type. Preserve typed gaps for unavailable bodies and referenced files.

- [ ] **Step 4: Persist messages through the shared source repository**

Replace the snapshot-only callback in the founder-stream runner with `captureGroupMessageSource()` and `ContextSourceRepository.saveSource()`. Keep the existing coverage/gap snapshot for audit.

- [ ] **Step 5: Add a dry-run-first CLI**

Require `--chat-id`, `--since` and `--dry-run` or `--persist`. Reject an unapproved chat before any API call. Dry-run prints aggregate counts only and never prints message text.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run tests/feishu-context-sync.test.ts tests/founder-stream-backfill.test.ts tests/feishu-sdk-client.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/services/feishu-context-sync.ts src/adapters/feishu-sdk.ts src/config.ts src/services/founder-stream-backfill.ts src/cli/backfill-founder-stream.ts package.json tests/feishu-context-sync.test.ts tests/founder-stream-backfill.test.ts tests/feishu-sdk-client.test.ts
git commit -m "feat: add auditable founder stream backfill"
```

### Task 4: Add emergent topic state and version history

**Files:**
- Create: `src/domain/topic.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Create: `src/repositories/topic-repository.ts`
- Create: `tests/topic-repository.test.ts`

**Interfaces:**
- Produces: `TopicStage = 'idea' | 'exploring' | 'project_candidate' | 'active_project' | 'paused' | 'closed'`
- Produces: `TopicRepository.createTopic`, `appendVersion`, `addSource`, `addRelation`, `listCurrentTopics`
- Produces relations: `same_as | split_from | part_of | related_to | supersedes`

- [ ] **Step 1: Write failing immutable-history tests**

```ts
const topic = repository.createTopic({ displayName: '买家知识库', stage: 'idea', createdAt });
repository.appendVersion({ topicId: topic.id, expectedVersion: 1,
  displayName: '房地产销售知识库', stage: 'exploring', outcome: null,
  rationale: '第二轮讨论扩大了范围', evidenceIds: ['ctxev_1'], changedAt });
expect(repository.listVersions(topic.id).map((v) => v.versionNumber)).toEqual([1, 2]);
```

Also assert merge and split relations do not delete either topic or its evidence.

- [ ] **Step 2: Run the test and verify missing schema**

Run: `pnpm vitest run tests/topic-repository.test.ts`  
Expected: FAIL because topic tables and repository do not exist.

- [ ] **Step 3: Add additive tables**

Create `context_topics`, `context_topic_versions`, `context_topic_sources` and `context_topic_relations`, with optimistic `expectedVersion` updates and unique stable relations.

- [ ] **Step 4: Implement repository transactions**

All version append and current-version pointer updates occur in one SQLite transaction. A version race throws `TOPIC_VERSION_CONFLICT`.

- [ ] **Step 5: Run test and commit**

Run: `pnpm vitest run tests/topic-repository.test.ts tests/migrate.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/domain/topic.ts src/db/schema.ts src/db/migrate.ts src/repositories/topic-repository.ts tests/topic-repository.test.ts tests/migrate.test.ts
git commit -m "feat: add emergent topic history"
```

### Task 5: Extract topics and projects only from supplied evidence

**Files:**
- Create: `src/ports/founder-stream-analyzer.ts`
- Create: `src/adapters/codex-founder-stream-analyzer.ts`
- Create: `src/services/topic-reconciler.ts`
- Create: `tests/codex-founder-stream-analyzer.test.ts`
- Create: `tests/topic-reconciler.test.ts`

**Interfaces:**
- Consumes: current topics plus immutable group/Minutes sources.
- Produces: strict JSON `FounderStreamAnalysis` containing topic proposals, stages, source mappings, join/split suggestions and confidence.
- Must not consume: legacy seed projects or system keyword rules.

- [ ] **Step 1: Write strict-schema tests**

Fixture input contains one early idea, a repeated discussion and an explicit work commitment. Assert output can keep the first as `idea` and promote the repeated discussion to `active_project` only when evidence contains both an outcome and action.

```ts
expect(result.topics).toEqual(expect.arrayContaining([
  expect.objectContaining({ stage: 'idea' }),
  expect.objectContaining({ stage: 'active_project' })
]));
```

Assert an output project name not tied to an evidence ID is rejected.

- [ ] **Step 2: Run tests and verify missing analyzer**

Run: `pnpm vitest run tests/codex-founder-stream-analyzer.test.ts tests/topic-reconciler.test.ts`  
Expected: FAIL because the analyzer and reconciliation policy do not exist.

- [ ] **Step 3: Define the strict output schema and prompt**

Require every topic proposal to include `displayName`, `stage`, `outcome`, `confidence`, `sourceIds`, `evidenceExcerpts`, and a join decision against current topics. The prompt explicitly says that projects are not preloaded and unformed ideas must not be upgraded.

- [ ] **Step 4: Implement conservative reconciliation**

Automatically join only high-confidence exact-continuation proposals with shared evidence terms. Medium/low-confidence joins create a `needs_confirmation` relation and leave both topics separate.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/codex-founder-stream-analyzer.test.ts tests/topic-reconciler.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/ports/founder-stream-analyzer.ts src/adapters/codex-founder-stream-analyzer.ts src/services/topic-reconciler.ts tests/codex-founder-stream-analyzer.test.ts tests/topic-reconciler.test.ts
git commit -m "feat: discover projects from founder stream evidence"
```

### Task 6: Model Ivy, James, shared and unresolved perspectives

**Files:**
- Create: `src/domain/alignment.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Create: `src/repositories/alignment-repository.ts`
- Create: `src/services/perspective-reconciler.ts`
- Create: `tests/alignment-repository.test.ts`
- Create: `tests/perspective-reconciler.test.ts`

**Interfaces:**
- Produces: `PerspectiveKind = 'ivy_view' | 'james_view' | 'shared_decision' | 'unresolved'`
- Produces: versioned perspective statements with evidence IDs.
- Requires: a configured participant identity mapping before attributing a group source to Ivy or James.

- [ ] **Step 1: Write failing attribution and silence tests**

Assert Ivy's statement updates only `ivy_view`; a later unrelated James message does not create `shared_decision`; an explicit “按A推进” followed by explicit agreement from the other founder may create a shared decision with both evidence IDs.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/alignment-repository.test.ts tests/perspective-reconciler.test.ts`  
Expected: FAIL because perspective storage and reconciliation do not exist.

- [ ] **Step 3: Add participant and perspective tables**

Create `founder_identities`, `topic_perspectives` and `topic_perspective_versions`. Unknown senders remain unknown and cannot be assigned by message order.

- [ ] **Step 4: Implement shared-decision evidence rules**

Require either explicit evidence from both configured founders or an explicit stored decision authority rule. Do not ship authority-rule configuration in this phase; therefore the MVP requires both-founder evidence.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/alignment-repository.test.ts tests/perspective-reconciler.test.ts tests/migrate.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/domain/alignment.ts src/db/schema.ts src/db/migrate.ts src/repositories/alignment-repository.ts src/services/perspective-reconciler.ts tests/alignment-repository.test.ts tests/perspective-reconciler.test.ts tests/migrate.test.ts
git commit -m "feat: track founder perspectives separately"
```

### Task 7: Build action-relevant alignment detection and notification policy

**Files:**
- Create: `src/services/alignment-detector.ts`
- Create: `src/services/alignment-notification-policy.ts`
- Modify: `src/repositories/outbox-repository.ts`
- Create: `tests/alignment-detector.test.ts`
- Create: `tests/alignment-notification-policy.test.ts`

**Interfaces:**
- Produces: `AlignmentIssue` lifecycle `candidate | ready | asked | resolved | dismissed | stale`.
- Produces: stable outbox key `alignment-question:<issueId>:<evidenceSetHash>`.
- Sends no message when action consequence or dual evidence is absent.

- [ ] **Step 1: Write the notification matrix tests**

Cover direction, next-action, owner, deadline and completion-standard divergence. Also cover brainstorming differences, missing second-founder evidence, naturally resolved discussion, repeat analysis and unchanged evidence.

```ts
expect(policy.evaluate(brainstormingDifference)).toEqual({ send: false, reason: 'no_action_consequence' });
expect(policy.evaluate(deliverableDifference)).toEqual({ send: true, reason: 'action_divergence' });
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/alignment-detector.test.ts tests/alignment-notification-policy.test.ts`  
Expected: FAIL because there is no alignment issue model.

- [ ] **Step 3: Implement detector and explicit policy**

The detector proposes issues; the policy independently checks evidence, action horizon, prior open issue and later resolution. Do not let the model directly enqueue a message.

- [ ] **Step 4: Add idempotent outbox support**

Mark an issue `asked` only in the same transaction that acknowledges a delivered Feishu message ID. Retry uses the same stable key.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/alignment-detector.test.ts tests/alignment-notification-policy.test.ts tests/context-review-outbox.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/services/alignment-detector.ts src/services/alignment-notification-policy.ts src/repositories/outbox-repository.ts tests/alignment-detector.test.ts tests/alignment-notification-policy.test.ts tests/context-review-outbox.test.ts
git commit -m "feat: gate group alignment reminders"
```

### Task 8: Render the initial 20-day work map and group questions

**Files:**
- Create: `src/services/founder-work-map-renderer.ts`
- Create: `src/services/alignment-question-renderer.ts`
- Modify: `src/adapters/feishu.ts`
- Create: `tests/founder-work-map-renderer.test.ts`
- Create: `tests/alignment-question-renderer.test.ts`

**Interfaces:**
- Produces: Feishu cards for `founder_work_map`, `alignment_question`, and `alignment_resolution`.
- Work map sections: active projects, candidates, exploring topics, ideas, paused/closed, uncertain grouping, coverage gaps.
- Every alignment question includes both source labels and one concise answer request.

- [ ] **Step 1: Write renderer contract tests**

Assert no more than 12 primary items per card, continuation cards use stable ordering, source excerpts are bounded, and zero-project input renders ideas without inventing a project section.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/founder-work-map-renderer.test.ts tests/alignment-question-renderer.test.ts`  
Expected: FAIL because renderers do not exist.

- [ ] **Step 3: Implement bounded Feishu cards**

Use existing interactive-card delivery. Buttons are optional shortcuts; every card must also state valid natural-language replies. Do not expose open IDs or internal confidence JSON.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run tests/founder-work-map-renderer.test.ts tests/alignment-question-renderer.test.ts tests/feishu-adapters.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/services/founder-work-map-renderer.ts src/services/alignment-question-renderer.ts src/adapters/feishu.ts tests/founder-work-map-renderer.test.ts tests/alignment-question-renderer.test.ts tests/feishu-adapters.test.ts
git commit -m "feat: render founder stream group cards"
```

### Task 9: Accept natural-language group corrections safely

**Files:**
- Create: `src/services/founder-feedback-router.ts`
- Create: `src/services/topic-correction-service.ts`
- Modify: `src/routes/feishu-events.ts`
- Create: `tests/founder-feedback-router.test.ts`
- Create: `tests/topic-correction-service.test.ts`

**Interfaces:**
- Consumes: replies bound to a delivered work-map or alignment-question message ID.
- Produces corrections: `merge_topics | split_topic | reclassify_stage | rename_topic | pause_topic | dismiss_alignment | resolve_alignment`.
- Rejects ambiguous unthreaded feedback with a short clarification response.

- [ ] **Step 1: Write failing Chinese natural-language routing tests**

Use the confirmed examples from the spec, including “2 和 4 是同一个项目” and “这个只是想法，还不是项目”. Assert a reply to an unrelated Bot message is rejected.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/founder-feedback-router.test.ts tests/topic-correction-service.test.ts`  
Expected: FAIL because group feedback is currently sent to the Ivy-private Todo router.

- [ ] **Step 3: Separate private Todo replies from approved-group feedback**

Route by `chat_id` first: Ivy private chat keeps the existing authorization router; the approved founder group uses the feedback router; all other chats fail closed.

- [ ] **Step 4: Apply corrections as immutable versions**

Use optimistic expected versions, store author open ID and source message ID, and create explicit merge/split relations. Never update old version content in place.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/founder-feedback-router.test.ts tests/topic-correction-service.test.ts tests/feishu-events-route.test.ts tests/reply-router.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/services/founder-feedback-router.ts src/services/topic-correction-service.ts src/routes/feishu-events.ts tests/founder-feedback-router.test.ts tests/topic-correction-service.test.ts tests/feishu-events-route.test.ts tests/reply-router.test.ts
git commit -m "feat: route founder group corrections"
```

### Task 10: Wire continuous group events through durable jobs

**Files:**
- Modify: `src/routes/feishu-events.ts`
- Modify: `src/repositories/job-repository.ts`
- Modify: `src/services/job-consumer.ts`
- Create: `src/services/founder-stream-worker.ts`
- Modify: `src/server.ts`
- Modify: `src/config.ts`
- Create: `tests/founder-stream-worker.test.ts`
- Modify: `tests/feishu-events-route.test.ts`

**Interfaces:**
- Enqueues: `capture_group_message:<messageId>` and `analyze_founder_stream_batch:<chatId>:<windowKey>`.
- Config flags: `FOUNDER_STREAM_CAPTURE_ENABLED=false`, `FOUNDER_STREAM_ANALYSIS_ENABLED=false`, `FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false`.
- Self-authored Bot messages are captured only as delivery audit and never reanalyzed as founder statements.

- [ ] **Step 1: Write failing webhook latency and idempotency tests**

Assert the HTTP route persists/enqueues and returns before Codex is called. Duplicate event IDs and message IDs create one source job. Non-approved groups create no job.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/feishu-events-route.test.ts tests/founder-stream-worker.test.ts`  
Expected: FAIL because approved-group events are routed as rejected private replies.

- [ ] **Step 3: Implement capture and debounce jobs**

Capture each source idempotently, then debounce analysis by chat/thread for 300 seconds. The durable job payload includes source IDs, never raw message text.

- [ ] **Step 4: Wire the worker behind independent flags**

Capture can be enabled without analysis; analysis can run without delivery; delivery cannot be enabled unless capture and analysis are enabled. Add startup validation for this dependency order.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/feishu-events-route.test.ts tests/founder-stream-worker.test.ts tests/config.test.ts tests/job-consumer.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/routes/feishu-events.ts src/repositories/job-repository.ts src/services/job-consumer.ts src/services/founder-stream-worker.ts src/server.ts src/config.ts tests/founder-stream-worker.test.ts tests/feishu-events-route.test.ts tests/config.test.ts tests/job-consumer.test.ts
git commit -m "feat: process founder group messages incrementally"
```

### Task 11: Feed Feishu Minutes into the same topic and alignment pipeline

**Files:**
- Modify: `src/services/meeting-worker.ts`
- Modify: `src/services/context-source-capture.ts`
- Modify: `src/services/founder-stream-worker.ts`
- Create: `tests/minute-founder-stream.integration.test.ts`

**Interfaces:**
- Consumes: the already captured immutable minute transcript source.
- Enqueues: the same `analyze_founder_stream_batch` job with source type `minute_transcript`.
- Preserves: existing personalized meeting summary and Todo delivery behavior.

- [ ] **Step 1: Write an integration test with chat and Minutes evidence**

Create a chat source introducing an idea and a later minute source turning it into an action. Assert they reconcile into one topic, preserve both source IDs, and do not duplicate the existing meeting-summary outbox.

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm vitest run tests/minute-founder-stream.integration.test.ts`  
Expected: FAIL because Minutes Context extraction and group-topic analysis are separate pipelines.

- [ ] **Step 3: Enqueue shared analysis after successful minute source capture**

Use a stable source-set job key. Failure in founder-stream analysis must not block the existing summary/Todo transaction or delivery.

- [ ] **Step 4: Run integration and regression tests, then commit**

Run: `pnpm vitest run tests/minute-founder-stream.integration.test.ts tests/meeting-loop.acceptance.test.ts tests/phase1e-context-loop.integration.test.ts && pnpm typecheck`  
Expected: PASS.

```bash
git add src/services/meeting-worker.ts src/services/context-source-capture.ts src/services/founder-stream-worker.ts tests/minute-founder-stream.integration.test.ts tests/meeting-loop.acceptance.test.ts tests/phase1e-context-loop.integration.test.ts
git commit -m "feat: unify minutes with founder stream context"
```

### Task 12: Add diagnostics, deletion boundary and production-disabled runbook

**Files:**
- Create: `src/routes/founder-stream-diagnostics.ts`
- Modify: `src/app.ts`
- Modify: `deploy/bridge.env.example`
- Create: `docs/founder-stream-20-day-runbook.md`
- Create: `tests/founder-stream-diagnostics.test.ts`
- Create: `tests/founder-stream-e2e.test.ts`

**Interfaces:**
- Produces: aggregate-only `GET /diag/founder-stream`.
- Reports: requested/observed window, source counts, topic counts by stage, open alignment issue counts, last cursors, gap codes, queued/retry jobs and outbox states.
- Runbook contains: preflight, exact 20-day timestamp, dry-run, persistence run, initial-map preview, explicit send approval, rollback and scoped deletion procedure.

- [ ] **Step 1: Write diagnostics redaction and end-to-end tests**

Assert diagnostics contain no message text, excerpts, open IDs, tokens or secrets. The end-to-end fixture must cover history → source → topic → perspectives → alignment question → group correction → resolved receipt.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/founder-stream-diagnostics.test.ts tests/founder-stream-e2e.test.ts`  
Expected: FAIL because the diagnostic route and complete orchestration do not exist.

- [ ] **Step 3: Implement aggregate diagnostics and runbook**

Keep all new env flags false in `deploy/bridge.env.example`. The runbook must state that writing the plan and passing local tests do not authorize production access.

- [ ] **Step 4: Run the full local verification gate**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all tests pass, TypeScript exits 0, build exits 0, and diff check produces no output.

- [ ] **Step 5: Commit the local implementation boundary**

```bash
git add src/routes/founder-stream-diagnostics.ts src/app.ts deploy/bridge.env.example docs/founder-stream-20-day-runbook.md tests/founder-stream-diagnostics.test.ts tests/founder-stream-e2e.test.ts
git commit -m "docs: add founder stream rollout boundary"
```

### Task 13: Independent review gate before any production proposal

**Files:**
- Review: all files changed by Tasks 1–12
- Update only if review finds defects: `docs/founder-stream-20-day-runbook.md`

**Interfaces:**
- Produces: a review report with `PASS` or `HOLD`.
- Does not produce: deployment, server commands, Feishu reads or group messages.

- [ ] **Step 1: Review against the spec's ten success criteria**

Verify each criterion has a named automated test and inspect the implementations for fail-open behavior, source loss, false shared decisions and notification loops.

- [ ] **Step 2: Inspect the migration on fresh and legacy SQLite fixtures**

Confirm fresh databases have no preset projects; legacy rows remain auditable but discovery-ineligible; user corrections are preserved.

- [ ] **Step 3: Re-run the full local gate from a clean process**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 4: Stop at the production approval gate**

Prepare a separate production change sheet containing the exact `since` timestamp, Feishu permissions, flags, backup, dry-run, source count preview, first group-card preview, deletion/rollback commands and explicit approval points. Do not execute it in this task.

