# Space classification retention and separate Smart Listing submission

## Scope and spec

Ivy approved fixing classification retention and separately submitting the missing Smart Listing version on 2026-11-01. No deployment, restart, configuration changes, or outgoing messages are authorized by this change. Work in the existing `codex/stable-decisions` worktree; preserve unrelated local files.

For an unchanged paragraph, preserve its entire previous problems/divergences/decisions group, including wording, order and absence from those sections. Judge new/edited paragraphs afresh. Retained items take priority within existing caps (3/20/20). An unchanged paragraph requires equal ID and a locally computed full-content hash, not just a still-matching excerpt or provider hash. Only previously visible input can establish absence. Legacy missing decisions means unknown, not empty. Missing historical source/input must not freeze new output. Other sections continue to regenerate.

Smart Listing ingestion is independent of candidate deployment. Check live page and production versions, save evidence, submit only the latest registered page through its existing submit-only SSH interface once, and verify receipt/version/worker outcome. Keep the failed historical snapshot as evidence; do not submit it as current when a newer page exists. No external retry after uncertain outcome without checking.

## Global constraints

- Use server-local Codex only for any AI calls; no API fallback.
- Preserve production code/image/configuration. No Feishu messages.
- No change to automation script, allow rules, or other four page submissions.
- Private page text and production evidence stay local, outside code commits.

### Task 1: Stabilize whole classification groups

**Files:** `src/services/space-project-digest.ts`, `src/services/founder-stream-worker.ts`, their existing test files.

**Interfaces:** Add optional full-content hash to digest input blocks (always populated by the production builder). Carryover receives the previous digest input, reconstructed from the ready digest's own page source, plus the complete previous source blocks. Missing hash/input means unknown. Positive classifications use the complete historical source even if historical prompt reconstruction drops their paragraphs. For previously truncated inputs, preserve positive items only; absence cannot reliably be inferred from a reconstructed historical prompt.

1. Add failing tests for partial same-paragraph loss, negative classifications, old-first caps, same-ID content changes beyond prompt truncation, unseen/missing history, legacy decisions, and worker snapshot selection.
2. Run targeted tests. Expected: new regression cases fail under 41e9cbb.
3. Implement bounded deterministic retention with exact source verification; run targeted tests and typecheck. Expected: pass.
4. Run full suite/build and independent review. Expected: all pass, no Important/Critical findings outstanding. Keep local changes reviewable; no push/merge/deploy.

### Task 2: Submit Smart Listing separately

**Files:** local evidence under root `docs/reviews/2026-11-01-classification-fix/`; optional existing local snapshot/state after successful confirmation only.

**Interfaces:** live Pages read, forced `submit smart-listing <updatedAt> <base64 title>` with exact Markdown stdin; readonly production probe.

1. Read live page and current production rows. Expected: identify latest content and whether missing.
2. Save immutable snapshot + hashes and submit the latest version once if absent. Expected: successful receipt or explicit error; no invented success.
3. Verify committed version, hash, sync receipt, worker outcome and no outgoing messages. Expected: match submitted snapshot and known processing status.
4. Record both independent outcomes and limitations in report and MEMORY.

## Review focus

Check partial multiple items per paragraph, legacy missing fields, same IDs with edited text after 3000 characters, truncated historical prompts, ready digest older than immediate previous version, caps and grounding; check that only one page is submitted and no deployment/message occurs.
