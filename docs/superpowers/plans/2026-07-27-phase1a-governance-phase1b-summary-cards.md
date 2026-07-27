# Phase 1a Governance and Phase 1b Summary Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Bridge resource discipline and deliver validated Feishu interactive meeting-summary cards with guaranteed text fallback.

**Architecture:** Zod Summary v1 is the platform-neutral boundary between Codex and delivery. A focused renderer converts validated summaries to Feishu schema 2.0 cards, while the existing text renderer and persisted Todo authorization model remain the fail-safe compatibility path.

**Tech Stack:** Node.js 20+, TypeScript, Zod 4, Vitest 3, Fastify 5, Feishu Node SDK, SQLite, Docker Compose.

## Global Constraints

- No server deletion, cleanup, root crontab change, production env change, or restart without Ivy's explicit approval.
- Delivery remains Ivy private chat and requires no new Feishu permission.
- `WAKE_WORD` defaults to empty and only marks direct instructions; it never executes them.
- JSON validation failure must fall back to the existing text path and must not lose the message.
- Preserve the current fail-closed Todo authorization state machine.
- Deploy A3 and Phase 1b together with one container rebuild/restart.

---

### Task 1: Summary v1 schema and configuration

**Files:**
- Create: `src/schema/summary.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `deploy/bridge.env.example`
- Test: `tests/summary-schema-v1.test.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `SummaryV1Schema`, `SummaryV1`, `parseSummaryV1(input: unknown): SummaryV1`.
- Produces: `config.wakeWord: string` and `CODEX_TIMEOUT_SECONDS=300`.

- [ ] Write failing tests for the exact v1 shape, eight action types, three alignment values, required reasoning for implicit todos, fixed schema version, and empty default wake word.
- [ ] Run `pnpm test -- tests/summary-schema-v1.test.ts tests/config.test.ts` and confirm failures are caused by missing v1/config behavior.
- [ ] Implement bounded Zod schemas and config defaults; add comments documenting the Phase 4 hook, action routing, and source traceability.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Codex summarizer produces Summary v1

**Files:**
- Modify: `src/adapters/codex-summarizer.ts`
- Modify: `src/composition/meeting-summarizer.ts`
- Modify: `src/ports/summarizer.ts`
- Test: `tests/codex-summarizer.test.ts`
- Test: `tests/meeting-summarizer-composition.test.ts`

**Interfaces:**
- Consumes: `parseSummaryV1`, `config.wakeWord`.
- Produces: `MeetingSummarizer.summarize(context): Promise<SummaryV1>`.

- [ ] Write failing tests that inspect the output schema and prompt for JSON-only output, exhaustive-but-grounded todos, implicit reasoning, AI-todo cross-checking, Ivy-only wake-word scanning, speaker normalization, transcript-language output, and source fields.
- [ ] Run the focused tests and confirm expected failures.
- [ ] Replace the old output schema/prompt with Summary v1 and pass `WAKE_WORD` through composition.
- [ ] Re-run focused tests and preserve Codex CLI structured-output compatibility.

### Task 3: Persisted Todo compatibility mapping

**Files:**
- Modify: `src/services/meeting-worker.ts`
- Modify: `src/domain/meeting.ts`
- Modify: `src/services/summary-renderer.ts`
- Test: `tests/meeting-worker.test.ts`
- Test: `tests/meeting-loop.acceptance.test.ts`

**Interfaces:**
- Consumes: `SummaryV1.todos`.
- Produces: existing persisted `risk/capability` fields and existing plain-text fallback body.

- [ ] Write failing tests proving existing reply-number lookup still works and unsafe/unknown action types remain fail-closed.
- [ ] Run focused tests and confirm the failure comes from the new Summary v1 incompatibility.
- [ ] Add an explicit Summary v1 → persisted Todo compatibility mapper; derive legacy plain text from v1 without weakening authorization.
- [ ] Re-run focused tests and confirm the existing acceptance loop passes.

### Task 4: Feishu card renderer

**Files:**
- Create: `src/card/renderer.ts`
- Test: `tests/card-renderer.test.ts`

**Interfaces:**
- Produces: `renderSummaryCard(summary: SummaryV1): FeishuInteractiveCard`.

- [ ] Write failing tests/snapshots for schema 2.0, `update_multi`, header metadata, section omission, direct-instruction-first stable ordering, Chinese action labels, owner/alignment display, and source link.
- [ ] Run `pnpm test -- tests/card-renderer.test.ts` and confirm the module/function is missing.
- [ ] Implement a pure renderer using markdown elements and dividers, with no buttons.
- [ ] Re-run the renderer tests and review the snapshot for accidental empty sections.

### Task 5: Interactive delivery and text fallback

**Files:**
- Modify: `src/adapters/feishu.ts`
- Modify: `src/adapters/feishu-sdk.ts`
- Modify: `src/repositories/outbox-repository.ts`
- Modify: `src/composition/worker-runtime.ts`
- Test: `tests/feishu-sdk-client.test.ts`
- Test: `tests/feishu-adapters.test.ts`
- Test: `tests/worker-runtime-composition.test.ts`

**Interfaces:**
- Produces: SDK methods for `msg_type: interactive` and `msg_type: text`.
- Guarantees: invalid raw JSON logs a warning with reason plus at most 500 characters, then sends the legacy text body.

- [ ] Write failing tests for interactive payload shape, real message-id validation, invalid-summary fallback, 500-character log truncation, and no lost outbox message.
- [ ] Run focused tests and confirm expected failures.
- [ ] Add the minimal delivery union and fallback orchestration, keeping secrets and full transcript/raw output out of logs.
- [ ] Re-run focused tests and confirm both delivery paths acknowledge the outbox only after successful send.

### Task 6: Transcript-to-card integration fixture

**Files:**
- Create: `src/fixtures/minute-transcript-summary-card.json`
- Create: `tests/summary-card.integration.test.ts`

**Interfaces:**
- Consumes: summarizer, `parseSummaryV1`, renderer.
- Produces: proof that a fixture transcript reaches an interactive card.

- [ ] Write the failing integration test with a fake Codex structured output and a real Summary v1 parse/render chain.
- [ ] Run the integration test and confirm it fails before the chain is wired.
- [ ] Add the minimal fixture and wiring needed for the full chain.
- [ ] Re-run the integration test and confirm the card contains metadata, points, todos/alignment, and source URL.

### Task 7: Resource controls and SQLite backup

**Files:**
- Modify: `deploy/docker-compose.production.yml`
- Create: `deploy/backup-sqlite.sh`
- Modify: `AGENTS.md`
- Modify: `docs/tencent-cloud-deployment.md`
- Test: `tests/deployment-assets.test.ts`
- Test: `tests/job-consumer.test.ts`

**Interfaces:**
- Produces: 512 MiB container limit, documented single-consumer invariant, 300-second default timeout, consistent SQLite backups retaining 14 files.

- [ ] Write failing deployment-asset tests for `mem_limit: 512m`, backup `.backup`, destination path, 14-file retention, and current AGENTS status; retain the existing consumer non-overlap test.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the compose/docs/script changes; make the backup script fail closed, create the destination, timestamp output, and delete only excess matching backup files after success.
- [ ] Re-run focused tests and run `bash -n deploy/backup-sqlite.sh`.

### Task 8: Full local verification and deployment proposal

**Files:**
- Modify: `MEMORY.md`

- [ ] Run `pnpm test` and confirm zero failing tests.
- [ ] Run `pnpm typecheck` and confirm exit 0.
- [ ] Run `pnpm build` and confirm exit 0.
- [ ] Run `git diff --check` and inspect `git diff --stat`.
- [ ] Record architecture decisions, the SSH refusal, and verified results in `MEMORY.md` without credential values.
- [ ] Output the exact A1/A2/A4 sudo proposals and the single-restart deployment/rollback plan; wait for Ivy's explicit approval.

### Task 9: Approved production deployment and acceptance

**Files:**
- Production: `/opt/feishu-codex/app`
- Production env: `/opt/feishu-codex/secrets/bridge.env`

- [ ] During an approved no-meeting window, verify the durable queue has no queued, retry, or processing job.
- [ ] Record the current commit/image, upload the verified source, set production `CODEX_TIMEOUT_SECONDS=300` through Ivy-approved action, and rebuild/restart once.
- [ ] Verify `/health` and `/ready` return 200 and have Ivy verify the 512 MiB memory limit with `docker inspect`.
- [ ] Run the short real meeting acceptance and verify interactive card delivery, all four content elements, a deliberately invalid JSON text fallback, and zero manual intervention.
- [ ] Write the Before/After, pitfalls, and evidence summary for construction log #002 and update `MEMORY.md`.
