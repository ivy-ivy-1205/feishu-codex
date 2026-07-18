# Meeting-to-Todo Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, fixture-driven MVP that receives a Feishu Minutes generated event, creates an Ivy-personalized meeting summary with numbered executable Todos, sends it to the configured Ivy–Codex private chat through an outbox, and safely resolves Ivy's reply to the correct Todo.

**Architecture:** A TypeScript/Fastify single service uses SQLite for durable events, meeting records, Todos, jobs, and outbox messages. External systems are behind narrow interfaces: Feishu event verification/data access, Codex structured summarization, and outbound message delivery. Phase 1A uses fixtures and fakes only; real Feishu, real Codex, group-history backfill, and writable task execution are later gated adapters.

**Tech Stack:** Node.js 20+, TypeScript 5, Fastify 5, Vitest, Zod, Drizzle ORM + better-sqlite3, Pino. The official Feishu Node SDK is deferred until the real-integration plan so Phase 1A carries no unused external adapter.

## Global Constraints

- Default meeting-summary destination is private chat `oc_d851c3e986007dc0f97ab582bcb2e7c8`.
- Subscribe conceptually to `minutes.minute.generated_v1`; Phase 1A tests use fixed payloads and do not connect to real Feishu.
- Never download meeting video. Do not process ordinary uploaded audio files.
- A generated Todo is not execution authorization. Only a message from verified Ivy `open_id`, bound to a summary reply context, can authorize it.
- Phase 1A ends after safely authorizing and routing a low-risk Todo; it does not call real Codex or execute the Todo. Real low-risk execution and all high-risk confirmation paths belong to `codex-runtime-and-execution`.
- No OpenAI API Key, no fallback provider, no AWS, no customer production database, and no production credentials.
- Codex integration must eventually use local `codex exec` with read-only sandbox, stdin, JSON Schema, timeout, and ChatGPT login Gate; Phase 1A defines and fakes the interface.
- Every production behavior follows RED → verify failure → GREEN → verify pass → refactor.
- Do not connect to real Feishu or modify the Tencent server in this plan.

---

## File Structure

```text
package.json                         scripts and pinned dependencies
tsconfig.json                        strict TypeScript configuration
vitest.config.ts                     isolated test configuration
.env.example                         non-secret configuration contract
src/app.ts                           Fastify composition root
src/server.ts                        process entrypoint only
src/config.ts                        environment parsing and safe public config
src/domain/meeting.ts                meeting, summary, Todo domain schemas
src/domain/authorization.ts          reply-context and risk authorization rules
src/ports/feishu.ts                  inbound/outbound Feishu interfaces
src/ports/summarizer.ts              structured meeting summarizer interface
src/db/client.ts                     SQLite connection factory
src/db/schema.ts                     Drizzle tables and unique constraints
src/db/migrate.ts                    migration bootstrap
src/repositories/meeting-repository.ts durable meeting/Todo operations
src/repositories/job-repository.ts   durable job lease operations
src/repositories/outbox-repository.ts durable outgoing-message operations
src/services/minute-ingestion.ts     idempotent minute event ingestion
src/services/meeting-worker.ts       transcript → summary → Todos orchestration
src/services/summary-renderer.ts     Ivy-facing message rendering
src/services/reply-router.ts         Ivy reply → exact Todo resolution
src/routes/health.ts                 /health and /ready
src/routes/feishu-events.ts          URL verification and event intake adapter
src/fixtures/minute-generated.json   deterministic Feishu event fixture
src/fixtures/minute-transcript.json  deterministic transcript fixture
tests/helpers/test-db.ts             temporary SQLite setup
tests/config.test.ts                 config security and ID separation
tests/minute-ingestion.test.ts       event allowlist/idempotency tests
tests/meeting-worker.test.ts          summary/Todo persistence tests
tests/summary-renderer.test.ts       reference-card copy structure tests
tests/reply-router.test.ts           no-cross-meeting authorization tests
tests/health.test.ts                 endpoint semantics
```

## Deferred Plans

The approved product spec remains authoritative, but these independently testable subsystems are intentionally deferred:

1. `group-history-backfill`: chat/thread pagination, files, document references, coverage report, voice policy.
2. `project-memory`: immutable source layer, versioned facts, decisions, conflicts, and `manual_ivy` ingestion.
3. `codex-runtime-and-execution`: real `codex exec`, ChatGPT auth Gate, low-risk execution adapters, high-risk confirmation.
4. `real-feishu-integration-and-deploy`: official SDK verification, Minutes transcript permissions, private-chat delivery, Tencent deployment.

---

### Task 1: Repository and Configuration Contract

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- Produces: `publicConfig(config: AppConfig): PublicConfig`
- `AppConfig` separates `ivyPrivateChatId` from optional `ivyApproverOpenIds`.

- [ ] **Step 1: Create the package/test configuration**

```json
{
  "name": "aijia-context-bridge",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "tsx src/server.ts"
  },
  "dependencies": {
    "better-sqlite3": "^12.2.0",
    "drizzle-orm": "^0.44.0",
    "fastify": "^5.0.0",
    "pino": "^9.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "drizzle-kit": "^0.31.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Use strict `NodeNext` TypeScript, Vitest `node` environment, and ignore `node_modules/`, `dist/`, `.env`, `data/`, and `*.sqlite*`.

- [ ] **Step 2: Write the failing config tests**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, publicConfig } from '../src/config.js';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: ':memory:',
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret-value',
  FEISHU_VERIFICATION_TOKEN: 'verify-value',
  FEISHU_ENCRYPT_KEY: 'encrypt-value',
  FEISHU_ALLOWED_CHAT_IDS: 'oc_a84d5b6ca478220d0a37964b50776edb',
  FEISHU_IVY_PRIVATE_CHAT_ID: 'oc_d851c3e986007dc0f97ab582bcb2e7c8',
  FEISHU_APPROVER_OPEN_IDS: '',
  CODEX_COMMAND: 'codex',
  CODEX_WORKDIR: '/tmp/aijia-codex-readonly',
  CODEX_TIMEOUT_SECONDS: '120'
};

describe('loadConfig', () => {
  it('keeps the private chat ID separate from Ivy user identity', () => {
    const config = loadConfig(baseEnv);
    expect(config.feishu.ivyPrivateChatId).toMatch(/^oc_/);
    expect(config.feishu.approverOpenIds).toEqual([]);
  });

  it('rejects a chat ID used as an approver identity', () => {
    expect(() => loadConfig({ ...baseEnv, FEISHU_APPROVER_OPEN_IDS: 'oc_wrong' }))
      .toThrow(/open_id must start with ou_/);
  });

  it('never exposes secrets in public config', () => {
    const visible = JSON.stringify(publicConfig(loadConfig(baseEnv)));
    expect(visible).not.toContain('secret-value');
    expect(visible).not.toContain('verify-value');
    expect(visible).not.toContain('encrypt-value');
  });
});
```

- [ ] **Step 3: Run the config test and verify RED**

Run: `pnpm test -- tests/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 4: Implement strict config parsing**

Define Zod schemas with exact defaults: port `3000`, debounce `300`, Codex timeout `120`, voice transcription `false`. Parse comma-separated IDs; reject any approver value not starting `ou_`. `publicConfig` returns only environment, port, database kind, allowed chat count, private chat configured, approver count, voice enabled, and Codex command basename.

- [ ] **Step 5: Verify GREEN and typecheck**

Run: `pnpm test -- tests/config.test.ts && pnpm typecheck`

Expected: 3 tests PASS; TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts tests/config.test.ts
git commit -m "chore: define bridge configuration contract"
```

---

### Task 2: Domain Types and SQLite Schema

**Files:**
- Create: `src/domain/meeting.ts`
- Create: `src/db/client.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/migrate.ts`
- Create: `src/repositories/meeting-repository.ts`
- Test: `tests/helpers/test-db.ts`
- Test: `tests/meeting-repository.test.ts`

**Interfaces:**
- Produces: `MeetingRepository.ingestMinute(input): { created: boolean; minuteId: string }`
- Produces: `MeetingRepository.saveSummary(input): MeetingSummaryRecord`
- Produces: `MeetingRepository.listTodos(summaryId): MeetingTodoRecord[]`
- Produces: `MeetingRepository.findTodoByReply(summaryMessageId, displayedNumber): MeetingTodoRecord | null`

- [ ] **Step 1: Write domain schemas**

Create Zod schemas for `MinuteGeneratedEvent`, `TranscriptSegment`, `MeetingSummaryDraft`, and `MeetingTodoDraft`. Restrict Todo risk to `low | high`; initial status to `proposed | authorized | running | completed | failed | needs_confirmation`.

- [ ] **Step 2: Write failing repository tests**

```ts
it('stores a minute only once', () => {
  const repo = createTestMeetingRepository();
  expect(repo.ingestMinute({ minuteId: 'min_1', eventId: 'evt_1' }).created).toBe(true);
  expect(repo.ingestMinute({ minuteId: 'min_1', eventId: 'evt_2' }).created).toBe(false);
});

it('resolves a displayed number only inside its summary message', () => {
  const repo = seededTwoMeetingRepository();
  expect(repo.findTodoByReply('om_summary_a', 1)?.id).toBe('todo_a_1');
  expect(repo.findTodoByReply('om_summary_b', 1)?.id).toBe('todo_b_1');
  expect(repo.findTodoByReply('om_unknown', 1)).toBeNull();
});
```

- [ ] **Step 3: Run repository tests and verify RED**

Run: `pnpm test -- tests/meeting-repository.test.ts`

Expected: FAIL because repository/schema modules do not exist.

- [ ] **Step 4: Implement schema and repository**

Create tables `feishu_events`, `meeting_minutes`, `meeting_summaries`, `meeting_todos`, `batch_jobs`, `outbox`, and `approval_actions`. Add unique constraints on event ID, minute ID, `(summary_id, displayed_number)`, summary message ID, and outbox idempotency key. Wrap `saveSummary` and Todo inserts in one transaction.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- tests/meeting-repository.test.ts && pnpm typecheck`

Expected: repository tests PASS; TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain src/db src/repositories/meeting-repository.ts tests/helpers tests/meeting-repository.test.ts
git commit -m "feat: persist meeting summaries and scoped todos"
```

---

### Task 3: Idempotent Minutes Event Ingestion

**Files:**
- Create: `src/fixtures/minute-generated.json`
- Create: `src/services/minute-ingestion.ts`
- Create: `src/repositories/job-repository.ts`
- Test: `tests/minute-ingestion.test.ts`

**Interfaces:**
- Consumes: `MeetingRepository.ingestMinute`
- Produces: `ingestMinuteGenerated(event, dependencies): IngestionResult`
- Produces: one durable job with kind `process_minute`, stable key `minute:<minuteId>`.

- [ ] **Step 1: Add a sanitized `minutes.minute.generated_v1` fixture**

The fixture must include schema `2.0`, event ID `evt_minute_1`, event type `minutes.minute.generated_v1`, and minute token `min_fixture_1`; it must contain no real tenant or user data.

- [ ] **Step 2: Write failing ingestion tests**

```ts
it('creates one durable job for a new minute', () => {
  const result = ingestFixtureTwice({ times: 1 });
  expect(result.jobs).toEqual([{ kind: 'process_minute', key: 'minute:min_fixture_1' }]);
});

it('does not duplicate work when Feishu retries the event', () => {
  const result = ingestFixtureTwice({ times: 2 });
  expect(result.minuteCount).toBe(1);
  expect(result.jobCount).toBe(1);
});

it('ignores unsupported event types', () => {
  expect(ingestEvent({ header: { event_type: 'vc.meeting.recording_ready_v1' } }).status)
    .toBe('ignored');
});
```

- [ ] **Step 3: Run ingestion tests and verify RED**

Run: `pnpm test -- tests/minute-ingestion.test.ts`

Expected: FAIL because ingestion service/job repository do not exist.

- [ ] **Step 4: Implement transactionally idempotent ingestion**

Validate input with the domain schema. In one SQLite transaction insert the event, upsert the minute, and insert the job with `ON CONFLICT DO NOTHING`. Return `accepted | duplicate | ignored`; never call Codex or Feishu inside the transaction.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- tests/minute-ingestion.test.ts`

Expected: all ingestion tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fixtures/minute-generated.json src/services/minute-ingestion.ts src/repositories/job-repository.ts tests/minute-ingestion.test.ts
git commit -m "feat: ingest minute events idempotently"
```

---

### Task 4: Structured Summarizer Port and Meeting Worker

**Files:**
- Create: `src/fixtures/minute-transcript.json`
- Create: `src/ports/feishu.ts`
- Create: `src/ports/summarizer.ts`
- Create: `src/services/meeting-worker.ts`
- Create: `src/repositories/outbox-repository.ts`
- Test: `tests/meeting-worker.test.ts`

**Interfaces:**
- Produces: `FeishuMinutesReader.getMinute(minuteId): Promise<MinuteContext>`
- Produces: `MeetingSummarizer.summarize(context): Promise<MeetingSummaryDraft>`
- Produces: `processMinuteJob(job, deps): Promise<'completed' | 'retry'>`
- Produces: outbox message kind `ivy_meeting_summary` with stable key `minute-summary:<minuteId>`.

- [ ] **Step 1: Add deterministic transcript fixture**

Include meeting title/time, three speaker-attributed transcript segments, one confirmed decision, one risk, and three Codex-capable low-risk Todo candidates. Do not include video or raw audio.

- [ ] **Step 2: Write failing worker tests**

```ts
it('persists one structured summary and numbered todos', async () => {
  const result = await runWorkerWithFixture();
  expect(result.summary.coreInsights).toHaveLength(3);
  expect(result.todos.map(todo => todo.displayedNumber)).toEqual([1, 2, 3]);
  expect(result.outbox[0].targetChatId).toBe('oc_d851c3e986007dc0f97ab582bcb2e7c8');
});

it('retries without sending when the transcript is not ready', async () => {
  const result = await runWorkerWithReaderError('MINUTE_NOT_READY');
  expect(result.jobStatus).toBe('retry');
  expect(result.outbox).toHaveLength(0);
});

it('does not create duplicate summaries on retry', async () => {
  const result = await runSameMinuteTwice();
  expect(result.summaryCount).toBe(1);
  expect(result.outboxCount).toBe(1);
});
```

- [ ] **Step 3: Run worker tests and verify RED**

Run: `pnpm test -- tests/meeting-worker.test.ts`

Expected: FAIL because ports/worker/outbox repository do not exist.

- [ ] **Step 4: Implement ports and orchestration**

The worker leases one job, reads `MinuteContext`, calls the summarizer, validates its Zod result, persists summary/Todos, inserts one outbox record, and completes the job in transactions. Map `MINUTE_NOT_READY` and rate-limit errors to retry with capped exponential backoff; map validation errors to permanent failure with a redacted reason.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- tests/meeting-worker.test.ts && pnpm typecheck`

Expected: worker tests PASS; TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/fixtures/minute-transcript.json src/ports src/services/meeting-worker.ts src/repositories/outbox-repository.ts tests/meeting-worker.test.ts
git commit -m "feat: process minute transcripts into durable todos"
```

---

### Task 5: Ivy-Personalized Summary Rendering

**Files:**
- Create: `src/services/summary-renderer.ts`
- Test: `tests/summary-renderer.test.ts`

**Interfaces:**
- Produces: `renderMeetingSummary(summary, todos): string`
- Output sections: title/metadata, `核心信息`, `我可以帮你推进`.

- [ ] **Step 1: Write failing renderer tests**

```ts
it('renders the reference interaction structure', () => {
  const text = renderFixtureSummary();
  expect(text).toContain('个性化会后总结');
  expect(text).toContain('核心信息');
  expect(text).toContain('我可以帮你推进');
  expect(text).toMatch(/1\. .+\n2\. .+\n3\. /);
});

it('does not claim Codex can perform human-only actions', () => {
  expect(() => renderSummaryWithTodo({ capability: 'human_only' }))
    .toThrow(/cannot be offered as executable/);
});

it('stays below the Feishu card/message size budget', () => {
  expect(Buffer.byteLength(renderFixtureSummary(), 'utf8')).toBeLessThan(28_000);
});
```

- [ ] **Step 2: Run renderer tests and verify RED**

Run: `pnpm test -- tests/summary-renderer.test.ts`

Expected: FAIL because renderer does not exist.

- [ ] **Step 3: Implement deterministic rendering**

Render concise Chinese copy. Sort Todos by displayed number. Reject empty insights, duplicate numbers, more than five Todo items, or non-executable `human_only` capability. Keep 2 KB safety margin below Feishu's 30 KB card limit.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- tests/summary-renderer.test.ts`

Expected: renderer tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/summary-renderer.ts tests/summary-renderer.test.ts
git commit -m "feat: render personalized meeting summaries"
```

---

### Task 6: Reply-Scoped Todo Authorization

**Files:**
- Create: `src/domain/authorization.ts`
- Create: `src/services/reply-router.ts`
- Test: `tests/reply-router.test.ts`

**Interfaces:**
- Produces: `routeReply(input, deps): ReplyDecision`
- `ReplyDecision`: `authorize_low_risk | require_high_risk_confirmation | identify_ivy | clarify | reject`.

- [ ] **Step 1: Write failing reply-routing tests**

```ts
it('authorizes Todo 1 only for verified Ivy replying to its summary', () => {
  expect(route({ openId: 'ou_ivy', replyTo: 'om_summary_a', text: '先干 1' }))
    .toMatchObject({ kind: 'authorize_low_risk', todoId: 'todo_a_1' });
});

it('rejects the same command from another user', () => {
  expect(route({ openId: 'ou_other', replyTo: 'om_summary_a', text: '先干 1' }).kind)
    .toBe('reject');
});

it('does not resolve Todo 1 from a different meeting', () => {
  expect(route({ openId: 'ou_ivy', replyTo: 'om_summary_b', text: '先干 1' }))
    .toMatchObject({ todoId: 'todo_b_1' });
});

it('asks for clarification when reply context is missing', () => {
  expect(route({ openId: 'ou_ivy', replyTo: null, text: '先干 1' }).kind)
    .toBe('clarify');
});

it('requires confirmation for external side effects', () => {
  expect(routeHighRiskTodo('发给客户').kind).toBe('require_high_risk_confirmation');
});
```

- [ ] **Step 2: Run router tests and verify RED**

Run: `pnpm test -- tests/reply-router.test.ts`

Expected: FAIL because authorization/router modules do not exist.

- [ ] **Step 3: Implement exact-context authorization**

Parse only explicit numbered commands and unambiguous natural-language matches. Require target private chat, verified `ou_` identity, and summary reply message ID. When no approver is configured, return `identify_ivy` and never authorize. High-risk capabilities are `code_write`, `external_message`, `deploy`, `delete`, and `production_access`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- tests/reply-router.test.ts && pnpm typecheck`

Expected: router tests PASS; TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/authorization.ts src/services/reply-router.ts tests/reply-router.test.ts
git commit -m "feat: bind Ivy replies to exact meeting todos"
```

---

### Task 7: Fastify App, Health, and Fixture Event Route

**Files:**
- Create: `src/app.ts`
- Create: `src/server.ts`
- Create: `src/routes/health.ts`
- Create: `src/routes/feishu-events.ts`
- Test: `tests/health.test.ts`
- Test: `tests/feishu-events-route.test.ts`

**Interfaces:**
- Produces: `buildApp(dependencies): FastifyInstance`
- Produces: `GET /health`, `GET /ready`, `POST /webhooks/feishu/events`.

- [ ] **Step 1: Write failing endpoint tests**

```ts
it('keeps liveness independent from dependency readiness', async () => {
  const app = buildTestApp({ ready: false, reason: 'CODEX_AUTH_REQUIRED' });
  expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  expect(ready.statusCode).toBe(503);
  expect(ready.json()).toMatchObject({ ready: false, reason: 'CODEX_AUTH_REQUIRED' });
});

it('echoes Feishu URL verification challenge', async () => {
  const response = await injectVerification({ challenge: 'challenge-token' });
  expect(response.json()).toEqual({ challenge: 'challenge-token' });
});

it('acknowledges a valid minute event without running the worker inline', async () => {
  const response = await injectMinuteFixture();
  expect(response.statusCode).toBe(200);
  expect(workerWasCalled()).toBe(false);
  expect(jobCount()).toBe(1);
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `pnpm test -- tests/health.test.ts tests/feishu-events-route.test.ts`

Expected: FAIL because app/routes do not exist.

- [ ] **Step 3: Implement composition and routes**

Keep `server.ts` limited to config loading, dependency creation, `listen`, and signal handling. Route adapter validates URL verification or event envelope, delegates to ingestion, and returns without invoking workers. Pino serializers must redact authorization, tokens, secrets, encrypt keys, transcript text, and raw event bodies.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- tests/health.test.ts tests/feishu-events-route.test.ts && pnpm typecheck`

Expected: route tests PASS; TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/server.ts src/routes tests/health.test.ts tests/feishu-events-route.test.ts
git commit -m "feat: expose safe Feishu event ingress"
```

---

### Task 8: Phase 1A Acceptance Harness and Documentation

**Files:**
- Create: `tests/meeting-loop.acceptance.test.ts`
- Create: `README.md`
- Create: `docs/local-development.md`
- Modify: `.env.example`

**Interfaces:**
- Proves the complete fixture flow without real Feishu/Codex.

- [ ] **Step 1: Write the failing end-to-end fixture test**

```ts
it('turns one minute fixture into a private summary and routes Ivy Todo 1', async () => {
  const harness = await createMeetingLoopHarness();
  await harness.postMinuteFixture();
  await harness.runOneWorkerCycle();
  const summary = harness.outbox.single();
  expect(summary.targetChatId).toBe('oc_d851c3e986007dc0f97ab582bcb2e7c8');
  expect(summary.body).toContain('我可以帮你推进');

  harness.confirmIvyOpenId('ou_ivy_fixture');
  const decision = await harness.reply({
    openId: 'ou_ivy_fixture',
    replyTo: summary.messageId,
    text: '先干 1'
  });
  expect(decision.kind).toBe('authorize_low_risk');
  expect(decision.todo.displayedNumber).toBe(1);
});
```

- [ ] **Step 2: Run acceptance test and verify RED**

Run: `pnpm test -- tests/meeting-loop.acceptance.test.ts`

Expected: FAIL until all harness composition is connected.

- [ ] **Step 3: Implement the minimal test harness and docs**

Document bundled Node/pnpm usage on the current Mac, environment setup without real secrets, database reset, fixture injection, worker cycle, test commands, known non-goals, and the four deferred plans. README must state prominently: no real Feishu connection, no writable Codex execution, no deployment in Phase 1A.

- [ ] **Step 4: Run full verification**

Run: `pnpm test && pnpm typecheck`

Expected: all tests PASS; TypeScript exits 0 with no warnings.

- [ ] **Step 5: Audit forbidden behavior**

Run:

```bash
rg -n "OPENAI_API_KEY|danger-full-access|docker push|kubectl|aws_|production" src tests .env.example
```

Expected: no API key fallback, no danger-full-access, no deployment commands, no AWS integration, and no production-access implementation. Intentional test strings may appear only in authorization-denial assertions.

- [ ] **Step 6: Commit**

```bash
git add tests/meeting-loop.acceptance.test.ts README.md docs/local-development.md .env.example
git commit -m "test: verify the local meeting to todo loop"
```

---

## Final Verification Gate

- [ ] Run `pnpm test` and record total passing tests and zero failures.
- [ ] Run `pnpm typecheck` and record exit code 0.
- [ ] Confirm `git status --short` contains no unintended generated files or secrets.
- [ ] Compare the implementation line by line with `docs/superpowers/specs/2026-07-18-feishu-codex-orchestrator-design.md` and list deferred—not missing—requirements.
- [ ] Do not claim Phase 1A complete until all four checks have fresh output.
