# Task 13 independent final gate — round 2 — PASS (local implementation only)

- Branch: `codex/founder-stream-alignment`.
- Baseline: `6ff9fabf7bbacdc2c1a876bebc4925a3cd8e2927`.
- Reviewed HEAD: `fe102db5e73fa42b0a1235cc24f7b1844b6d4613`.
- Review timestamp / frozen until: `2026-09-20T20:04:00.338Z` (2026-09-21 Asia/Shanghai).
- Frozen since: `2026-08-31T20:04:00.338Z`; duration `1,728,000,000 ms` (exactly 20×24 hours).
- Full review scope: AGENTS, MEMORY, approved design spec and implementation plan, progress ledger, runbook, and complete baseline-to-HEAD change set (93 files; 8,302 additions / 281 deletions), including integrated revisions after the first HOLD.
- No production, SSH, Feishu request, network call, real Codex execution or real message delivery. All executed tests use local fixtures/in-memory or temporary SQLite and injected boundaries.
- Only this report and `production-change-sheet.md` are updated, both gitignored. No tracked source/document or MEMORY modification.

## Findings

### Critical

None established in the reviewed local implementation scope.

### Important

None remaining in the reviewed local implementation scope. The four original HOLD findings and both follow-up defects are addressed as detailed below. The missing production semantic adapter remains an explicit rollout blocker, not an assertion that production automatic alignment is complete.

### Minor / operational observations

1. `docs/founder-stream-20-day-runbook.md:36` and `:53` use the source-tree command requiring `tsx/src`; the Docker runtime has `dist` and production dependencies. The accompanying proposal uses the actual built entrypoint `node dist/cli/backfill-founder-stream.js`. Confirm the exact approved image/working directory during preflight.
2. `AGENTS.md:6` retains an old “not connected/deployed” phase header while MEMORY contains later deployment history. Neither establishes present production state; a separately approved read-only preflight is required.
3. The feedback grammar is intentionally bounded (`src/services/founder-feedback-router.ts:9`), and content extraction from referenced files / native-voice ASR is not implemented by this patch. Existing platform voice text works; missing text is explicitly audited. Do not promise universal natural-language correction, full attachment reading or transcription.

## Original HOLD closure and integrated behavior

| Original finding / follow-up | Evidence at this HEAD | Result |
|---|---|---|
| 1. Automatic evidence overwrote human pause/reclassification/rename/outcome | `src/services/founder-stream-worker.ts:142` binds proposals targeting human-protected topics; `:176` applies one aggregated CAS; `:190` retains the authoritative human fields; `:347` derives authority from immutable correction audit, trusted target binding and source occurrence time. `tests/founder-stream-worker.test.ts:85` “keeps %s authoritative against old and newer automatic proposals” covers pause/reclassify/rename, outcome preservation, old and new evidence. `tests/topic-correction-service.test.ts:37` preserves audit and versions. | ADDRESSED |
| 1 follow-up. Multiple continuations to a protected topic caused CAS rollback and lost later suggestions | Worker groups once per target at `:152`, unions full evidence at `:179`, stable-deduplicates suggestions/relations at `:181` and `:343`. `tests/founder-stream-worker.test.ts:46` “aggregates every same-target protected proposal once with stable deduplicated evidence and suggestions” checks two independent protected topics, multiple/duplicate proposals, reversed model order, source duplication, replay, completed job and unchanged human fields. | ADDRESSED |
| 2. Different decision keys could ask multiple questions on one topic | `src/services/alignment-notification-policy.ts:77` gates all ready/asked issues on the topic. `:95` serializes retirement, evaluation, persistence, promotion and enqueue in one IMMEDIATE transaction. `tests/alignment-notification-policy.test.ts:123` tests ready/asked; `:136` terminal release; `:147` independent topics; `:175`/ `:185` expiry/natural-resolution release; `:200` is a real two-process WAL race yielding one open issue and one outbox. | ADDRESSED |
| 2 follow-up. Valid slot-deferred candidate was silently discarded in the real prepare path | `src/services/alignment-notification-policy.ts:101` saves only an otherwise-valid `open_issue_exists` candidate within the same transaction. No preinsert is needed. Tests at `:123`, `:136`, `:154`, `:164`, `:200`, `:330` verify persisted loser, replay, later re-prepare, invalid-candidate exclusion and candidate/outbox fault rollback. | ADDRESSED |
| 3. Capture-only completed sources had no later analysis handoff | `src/services/founder-stream-worker.ts:246` reconstructs unclaimed trusted group sources from durable job/source-set receipts, including restart; existing analysis jobs in all states prevent unbounded requeue. Recovery excludes unavailable/app/unknown/delivered-bot/correction sources, respects newest arrival per thread, emits ≤20-source batches and live recovery keys. `src/repositories/job-repository.ts:151` extends pending live deadlines atomically at arrival. Worker tests `:111`, `:142`, `:152`, `:160`, `:240` verify 25-source recovery in two calls, restart/replay, debounce, new arrivals, unknown/bot and large batches. | ADDRESSED |
| 4. Live native voice and unreadable messages had no typed coverage gap | `src/services/founder-stream-worker.ts:76` persists one metadata-only unavailable source plus a typed gap, never the resource key/bytes. `:371` maps native voice to VOICE_TEXT_MISSING and file/media/text to explicit policy gaps. Worker tests `:125` and `:135` verify duplicate-event idempotence, no analysis/download, aggregate-only diagnostics, and existing platform voice text entering text analysis. | ADDRESSED |

The fixes compose without weakening the earlier boundaries: capture-only recovery does not enqueue correction evidence as a new command; recovered user evidence still goes through the same protected-topic application boundary and semantic scope checks; aggregated proposals produce one target CAS while reminder preparation independently enforces the per-topic slot. Disabled flags cause no reconciliation or delivery. Group handling stays separated from Ivy private Todo authorization. The full suite includes the offline history→topic→dual-view→question→two-founder resolution loop and the original meeting-summary/Todo regressions.

Human reactivation remains an explicit correction through the verified current-card/expected-version path (`src/services/founder-feedback-router.ts:62`, `src/services/topic-correction-service.ts:112`); new automatic evidence only attaches a needs-confirmation suggestion. It does not reactivate a paused or closed topic.

## Ten success criteria → named automated evidence

| # | Spec criterion | Named evidence and static boundary | Assessment |
|---|---|---|---|
| 1 | Exact 20-day initialization; auditable pagination/termination | `tests/founder-stream-backfill.test.ts:48` “freezes the same explicit window for dry-run and persist despite later invocation time”; `:102` “requires an explicit exact window, pages roots and threads, deduplicates and persists immutable sources”; `:140` “retains every failure, page cursor and policy gap instead of claiming completeness”; SDK invalid has_more matrix. Window duration is frozen operationally, not hard-coded in the generic reader. | PASS locally |
| 2 | No preset projects on fresh DB | `tests/project-repository.test.ts:8` “lists no preset projects or mapping rules after a fresh migration”; `tests/migrate.test.ts:216` “adds project mapping columns and registry tables without preset authority”; legacy discovery exclusion at `:270`. No production seed imports. | PASS |
| 3 | Chat/Minutes share Source/Evidence | `tests/context-source-repository.test.ts:66` “reuses legacy minute evidence stored before discriminated locators”; group stable locator test at `:131`; `tests/minute-founder-stream.integration.test.ts:91` “joins an earlier chat idea with later meeting action without duplicate summary/Todo”; `:56` first-source eligibility preservation. | PASS with local reader/semantic fixtures |
| 4 | Unformed ideas remain distinct from active projects | `tests/codex-founder-stream-analyzer.test.ts:31` “keeps an unformed idea while accepting an evidenced outcome and current work commitment”; `:70` early-idea upgrade rejection; `tests/founder-work-map-renderer.test.ts:10` idea-only map; worker correction-authority matrix at `:85`. | PASS contract; real semantic quality not yet validated |
| 5 | Ivy/James views separated, not inferred from names | `tests/alignment-repository.test.ts:58` “attributes evidence only through configured immutable founder identities”; `tests/perspective-reconciler.test.ts:119` “updates only Ivy view and never turns a later unrelated James message into consensus”; `tests/minute-founder-stream.integration.test.ts:116` verified per-segment ID vs display name. | PASS contract; production adapter absent |
| 6 | Silence/acknowledgement is never shared decision | `tests/perspective-reconciler.test.ts:227` “does not trust an agreement label when the cited message only says read or later”; `:251`/ `:285` negation, quotation, condition and truncation; `:56`/ `:71` late ties/reversed batches; `tests/topic-correction-service.test.ts:101` both-founder confirmation; `tests/minute-evidence-order.test.ts:53` meeting/group uncertain ordering. | PASS contract |
| 7 | Natural-language merge/split/reclassify/pause preserve history | `tests/founder-feedback-router.test.ts:6` “binds Chinese numbered merge to the delivered card numbers”; explicit correction matrix at `:64`; `tests/topic-correction-service.test.ts:37`, `:65`, `:93` append-only audit, atomic rollback, split-parent preservation; protected-topic tests at worker `:46`/ `:85`. | PASS bounded grammar |
| 8 | Only action-relevant differences create group outbox | `tests/alignment-notification-policy.test.ts:243` five dimensions; `:250` brainstorming silence; `:256` independent founder evidence; `:299` full-source affirmative-action validation; `:123`/ `:200` one per topic sequential/concurrent; `tests/founder-stream-e2e.test.ts:14` complete fake loop. | PASS deterministic policy |
| 9 | Retry/replay/events do not duplicate sources/topics/messages | `tests/founder-stream-worker.test.ts:303` event/message duplicates; `:313` ID-only debounce; `:111` recovered source-set receipt; `:46` protected-topic replay; `tests/founder-stream-backfill.test.ts:102` source-set replay; `tests/feishu-sdk-client.test.ts:15` stable delivery UUID; correction replay at `tests/topic-correction-service.test.ts:49`. | PASS tested durable paths |
| 10 | Visible gaps; no production access in tests | `tests/founder-stream-backfill.test.ts:140` gap/cursor audit; `tests/founder-stream-worker.test.ts:125` live voice/file/text metadata gaps; `tests/founder-stream-diagnostics.test.ts:25` aggregate/privacy test and malformed-audit fail-closed tests. SDK/model/delivery seams are local fakes. | PASS |

## Fresh / legacy SQLite migrations

- Fresh migration creates the added topic, source-link, relation, founder identity, perspective version, observation, issue, event and feedback audit structures without inserting projects or system mapping rules.
- Existing projects gain conservative `origin=legacy_seed` and lifecycle columns, but retain their rows. Discovery excludes legacy seeds; ordinary existing registry lookup remains backward compatible for the old meeting/Todo path.
- `tests/migrate.test.ts:270` uses the old table shape, repeats migration and preserves archived OpenMontage, disabled system rule, active ivy_correction, pattern/project association and original correction timestamps. No seed upsert rewrites them.
- Raw SQL and Drizzle added enums, fields, foreign keys and uniqueness constraints were compared. Topic/perspective state is append-version plus CAS. `tests/topic-repository.test.ts:245` real two-process race returns one version-2 success and one domain conflict.
- Legacy undiscriminated Minute locators are still read and reused; format migration does not create duplicate evidence. Existing meeting/Todo/context fixtures now explicitly request legacy registry fixtures, rather than depending on production seeds.

## Deferred items and rulings audit

| Ledger item | Round 2 disposition |
|---|---|
| Task 1 archived/disabled/ivy_correction missing regression | CLOSED by old-shape/repeated migration test at `tests/migrate.test.ts:270`. |
| Task 5 bounded model window vs full 21+ evidence | CLOSED by worker tests `:189` (name/outcome anchors) and `:264` (26 persisted evidence IDs with model ≤20). No persisted history truncation. |
| Task 8 safe external Minutes traceability | CLOSED by `tests/minute-founder-stream.integration.test.ts:125`; external token/segment shown, internal source ID hidden. |
| Task 10 founder-only readiness | CLOSED by `tests/founder-stream-diagnostics.test.ts:100` enabled-pipeline matrix and consumer/auth failure checks. |
| Task 5 pure plan / needs_confirmation ruling | Implemented. Suggestions are preserved in version rationale; no speculative merge/delete is performed. |
| Task 7 persistence and Task 9 binding/audit extensions | Implemented with additive tables, exact delivery binding, transactional state transitions and immutable corrections. |
| Task 10/11 missing semantic adapter ruling | RETAINED. `src/server.ts:113` wires only topic analyzer. Worker `:165` returns no observations/proposals without the structured perspective port. This is not production automatic alignment. ANALYSIS and GROUP_DELIVERY must remain false until a separate real Codex adapter is implemented, independently reviewed, quality-checked and explicitly approved by Ivy. |
| Task 11 marked Minutes + trustworthy evidence order | Implemented. Unmarked/other-target legacy Minutes do not recover; unknown speaker remains unknown; ordinal timestamps are not invented elapsed time; uncertain overlap cannot sustain consensus. Dedicated Minute and late-conflict regressions pass. |
| Task 12 explicit --until and scoped-deletion reality | Implemented/documented. Exact same window supported. No purge or work-map-preview CLI is claimed. Preview and referenced-source deletion require scoped approved operations; shared references require another reviewed migration. |
| Task 13 round 1 HOLD ledger entry | Historical, superseded by this round-2 gate at fe102db. Four findings plus both follow-ups closed above. Controller can append the gate result to ledger after receiving it. |

## Fresh verification at fe102db

Each command ran in a fresh shell process from this worktree; no reused watcher/session result:

- `pnpm test`: exit 0, **70 test files / 682 tests passed**, duration **10.44 s**. Includes both real local two-process SQLite race tests.
- `pnpm typecheck`: exit 0.
- `pnpm build`: exit 0.
- `git diff --check`: exit 0, empty.
- `git diff --check 6ff9fab..HEAD`: exit 0, empty.
- `git status --short`: empty before and after both permitted ignored-report updates; no tracked changes.
- `git check-ignore` confirms both permitted audit reports are ignored.
- No new production results/counts/card contents are inferred from these local fixtures.

## Decision

**PASS — local implementation gate only.** No remaining Critical/Important within the approved local scope; all ten criteria have the named local evidence above.

This is **not** production authorization, not a claim of complete real-world semantic alignment, and not approval to merge/deploy/read a real chat/enable any flag/send a message. The accompanying change sheet is **a proposal, not executed**. Analysis and group delivery remain false while the production perspective/alignment adapter is absent. The next stage needs separate implementation/review and Ivy approval, one action at a time.

MEMORY was not changed by this read-only reviewer. The only new persistent content is the two permitted ignored audit artifacts.

