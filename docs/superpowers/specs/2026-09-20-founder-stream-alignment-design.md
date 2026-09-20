# Founder Stream Alignment Design

**Date:** 2026-09-20  
**Status:** Approved direction, local design only  
**Production access:** Not authorized by this document

## 1. Goal

Turn the existing Ivy–James Feishu group into the shared context foundation for AiJia. The system reads an explicitly authorized 20-day window once, continuously ingests later group messages and Feishu Minutes, discovers topics and projects from evidence instead of a preset registry, and posts only action-relevant alignment questions back into the same group.

The product is not a chat summarizer. It is a low-interruption alignment loop:

1. preserve what each person actually said;
2. organize changing ideas without requiring people to classify them first;
3. distinguish each person's current understanding from shared decisions;
4. detect differences that may produce divergent action;
5. ask one evidence-backed question in the shared group;
6. apply natural-language corrections without rewriting source history.

## 2. Confirmed product decisions

- The only initial group is `oc_a84d5b6ca478220d0a37964b50776edb`.
- Initial history scope is the most recent 20 days at the time of the approved production run.
- There are no preset projects and no keyword-seeded project authority.
- Project structure emerges from real group messages, threads, referenced material and Minutes.
- Unformed ideas remain ideas. They are not forced into projects.
- Group chat and Feishu Minutes are two entrances to the same Context system.
- The normal interface remains natural Feishu conversation. Ivy and James do not fill in project forms.
- Corrections are natural language replies in the same group.
- Alignment reminders are posted directly in the shared group, not privately to Ivy.
- A lack of response, a read receipt or a later message does not imply shared agreement.
- The system does not execute Todo items or external actions as part of this feature.

## 3. Non-goals

- Reading any non-whitelisted group or private chat.
- Automatically declaring strategic agreement.
- Automatically deciding which founder is correct.
- Treating every idea as a project.
- Replacing original messages with generated summaries.
- Downloading or parsing video or ordinary audio files.
- Enabling production sync, changing server configuration or sending a real group message during local implementation.
- Adding an OpenAI API key or direct usage-based model API path. All semantic processing continues through the authenticated server-local Codex CLI.

## 4. Core model

### 4.1 Source

An immutable source is something that actually happened:

- one Feishu group message;
- one post message;
- one thread reply;
- one supported referenced document snapshot;
- one Feishu Minutes transcript.

Every source keeps its external ID, author identity, occurrence time, group/thread location, content hash, version and availability status. Generated interpretations never replace a source.

### 4.2 Topic

A topic is the first organizational unit. It can exist before a project does.

Topic stages:

- `idea`: one or more related expressions without a committed next action;
- `exploring`: sustained discussion with competing or incomplete directions;
- `project_candidate`: a stated outcome or repeated action exists, but project boundaries are still uncertain;
- `active_project`: a working outcome and current action exist;
- `paused`: explicitly or operationally paused, with the reason preserved;
- `closed`: completed or abandoned, with its final state preserved.

A topic may be merged, split, renamed or related to another topic. These are versioned relations, not destructive rewrites.

### 4.3 Perspective

For each topic, the system may hold separate evidence-backed perspectives:

- `ivy_view`;
- `james_view`;
- `shared_decision`;
- `unresolved`.

Each perspective has a concise statement, supporting evidence, confidence and observation time. `shared_decision` requires explicit evidence of joint acceptance or an authorized decision rule; it cannot be inferred merely from silence or message order.

### 4.4 Alignment issue

An alignment issue is not any semantic difference. It is created only when all of the following are true:

1. a near-term action, commitment or deliverable is present;
2. two current perspectives or a current perspective and a previous shared decision differ materially;
3. the difference can change direction, next action, owner, deadline or completion standard;
4. the issue has source evidence that can be shown to both founders;
5. a short answer can alter the upcoming action.

Issue lifecycle:

- `candidate` → detected but not yet eligible to send;
- `ready` → evidence and notification policy pass;
- `asked` → one question was delivered in the shared group;
- `resolved` → later group evidence or an explicit correction resolved it;
- `dismissed` → founders indicate it is not a meaningful difference;
- `stale` → the action window passed without a safe resolution.

No issue is resent unless new evidence materially changes it.

## 5. Data flow

### 5.1 Twenty-day initialization

1. An explicit operator command receives a fixed group ID and `since` timestamp.
2. The reader pages root messages and thread replies until the API reports completion.
3. Each readable message becomes an immutable Context source; skipped or inaccessible content becomes an explicit coverage gap.
4. Sources are analyzed in chronological batches with overlapping prior context.
5. The analyzer proposes topics, topic stages, perspectives, shared decisions and candidate alignment issues.
6. The reconciler joins duplicate topics conservatively. Uncertain joins remain separate and are marked for correction.
7. One initial work-map card is prepared for the shared group. It is not sent until a separate production send approval.

The work map contains active projects, project candidates, exploring topics, ideas, paused/closed topics, uncertain groupings and coverage gaps. It does not ask users to approve every item; it asks them only to correct mistakes.

### 5.2 Continuous ingestion

`im.message.receive_v1` events from the approved group are separated from private Todo replies. The route acknowledges the webhook quickly, persists an idempotent source job and never runs Codex inside the HTTP request.

New group sources are debounced by conversation/thread window. The analyzer updates only affected topics and compares the new state with existing topic versions. Minutes enter the same analyzer after transcript capture, retaining speaker and timestamp evidence.

### 5.3 Feedback

Natural-language replies such as the following become versioned corrections:

- “2 和 4 是同一个项目”;
- “这个只是想法，还不是项目”;
- “这部分属于 Landing Page”;
- “这个方向已经停了”;
- “这里不是意见不同，是 James 还没看到背景”;
- “以后提到买家知识库都归到销售知识库”.

The correction parser must bind a reply to the delivered work map or alignment question. Ambiguous unthreaded messages are not guessed. A correction produces a new topic/version/relation or issue status and preserves the old interpretation for audit.

## 6. Project discovery policy

Fresh databases no longer seed nine projects or system keyword rules. Existing deployed rows are retained for audit but marked `legacy_seed` and excluded from automatic topic/project discovery unless real source evidence or a founder correction confirms them.

The analyzer may propose a project only from supplied sources. It returns:

- proposed display name;
- aliases observed in sources;
- stage;
- concise outcome;
- evidence IDs;
- reasons to join or not join existing topics;
- confidence.

Low-confidence project boundaries stay as topics. Human corrections outrank later model proposals, but can themselves be explicitly superseded by a later founder correction.

## 7. Shared-group messaging policy

The Bot may send only three message kinds to the shared group:

1. the explicitly approved initial 20-day work map;
2. an action-relevant alignment question;
3. a short resolution receipt after the group resolves that question.

It does not narrate routine classification. It ignores its own messages and deduplicates retried Feishu events.

Initial notification policy:

- no action consequence → no message;
- one open question per topic at a time;
- no new evidence → no repeated message;
- resolved naturally before delivery → cancel the candidate;
- missing or conflicting evidence → do not claim a disagreement;
- unsupported media or permission gap → disclose the gap in the work map, not as a disagreement.

## 8. Permissions, privacy and operational boundary

- The group allowlist remains fail-closed and contains only the confirmed chat ID.
- Historical sync remains disabled by default.
- A local implementation cannot run the production backfill.
- A production backfill needs a separate change sheet and Ivy's explicit approval.
- The change sheet must state the exact `since` timestamp, requested Feishu scopes, expected source types, retention setting, rollback and deletion procedure.
- Logs and diagnostics expose counts, cursors, source IDs and typed gap codes, never message bodies, tokens or credentials.
- Raw source retention and deletion policy must be decided before production enablement. Until then, the rollout flag remains off.

## 9. Failure behavior

- Pagination or permission failure records the last successful cursor and a typed gap; it never reports a complete import.
- Codex extraction failure retries through the durable job system and does not lose stored sources.
- Invalid model output fails closed and creates no project, perspective or alert.
- A missing author identity is stored as unknown and cannot be attributed to Ivy or James.
- Conflicting corrections create an unresolved relation; the latest message does not silently win.
- Outbox failure retains the alignment issue as `ready` or retryable; it is never marked `asked` without a delivered Feishu message ID.

## 10. Success criteria

The local implementation is ready for production review when fixtures prove all of the following:

1. a 20-day window is passed as an exact timestamp and history pagination terminates audibly;
2. a fresh database contains no preset projects;
3. messages and Minutes enter the same source/evidence model;
4. unformed ideas stay distinct from active projects;
5. Ivy and James perspectives remain separate;
6. silence never creates `shared_decision`;
7. natural-language corrections merge, split, reclassify and pause topics without deleting history;
8. only action-relevant differences generate group outbox messages;
9. duplicate events and repeated analysis do not duplicate sources, topics or messages;
10. coverage gaps are visible and no test touches Feishu production.

