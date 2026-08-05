# Tencent Cloud Deployment Notes

Phase 1A is not a full production rollout. These files prepare a repeatable server package for `/opt/feishu-codex`; real Feishu webhook activation still requires worker availability, real Feishu delivery, and Ivy approval for each server action.

## Server Workspace

Use the independent workspace:

```text
/opt/feishu-codex
  app/
  config/
  data/
  logs/
  secrets/
  codex-workdir/
```

Secrets live only on the server in:

```text
/opt/feishu-codex/secrets/bridge.env
```

Do not commit this file and do not paste secret values into chat.

## Runtime Shape

The Bridge container listens inside Docker on `3000` and is bound on the host as:

```text
127.0.0.1:3010 -> container:3000
```

That keeps the app private to the server. Public traffic should reach it only through the edge Nginx for:

```text
https://feishu-codex.aijia.ai/feishu/events
```

## Required Server Files

Copy or sync the repo into:

```text
/opt/feishu-codex/app
```

Create the secret env file from `deploy/bridge.env.example`:

```text
/opt/feishu-codex/secrets/bridge.env
```

Expected permissions:

```text
chmod 700 /opt/feishu-codex/secrets
chmod 600 /opt/feishu-codex/secrets/bridge.env
chown -R 1000:1000 /opt/feishu-codex/data /opt/feishu-codex/logs /opt/feishu-codex/codex-workdir
```

The container runs as the non-root `node` user. The writable host-mounted directories therefore need to be writable by uid `1000`.

## Current Readiness Caveat

`/health` checks HTTP process liveness.

`/ready` intentionally remains the gate for Feishu webhook activation. The codebase now has a durable-job consumer lifecycle and a production dependency wiring path, but `WORKER_ENABLED` defaults to `false`; the server must not report ready until Ivy approves real credentials, server-local Codex login, Feishu callback testing, and the worker enablement step.

Do not point Feishu production events at the service while `/ready` returns `READINESS_BLOCKED`.

Current expected blockers before real integration:

- `FEISHU_READER_UNAVAILABLE`
- `FEISHU_DELIVERY_UNAVAILABLE`
- `WORKER_CONSUMER_UNAVAILABLE`
- `CODEX_AUTH_UNAVAILABLE`

`WORKER_ENABLED=true` starts the durable-job consumer and wires one cycle through Feishu Minutes reading, meeting summarization, and pending meeting-summary delivery. Keep it `false` in `/opt/feishu-codex/secrets/bridge.env` until the real integration checklist is complete.

## Codex CLI Execution Boundary

The app boundary for AI execution is `src/adapters/codex-cli.ts`.

It deliberately runs only the local Codex CLI command and does not accept an OpenAI API key fallback. The adapter constructs:

```text
codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <json>
```

Meeting/task input is sent through stdin. The child process environment strips API-provider variables such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, and `ANTHROPIC_API_KEY`, so the Bridge cannot silently switch into direct model API calls.

Operationally this means:

- AI execution depends on the server-local Codex CLI and Ivy-approved interactive Codex/ChatGPT login.
- Before every JSON execution, the adapter runs `codex login status`; only a successful ChatGPT login status is accepted.
- Missing login, expired login, or API-key-like auth status fails closed as `CODEX_AUTH_REQUIRED` and does not run `codex exec`.
- The Bridge must fail closed with `CODEX_EXECUTION_FAILED` or `CODEX_OUTPUT_INVALID` when Codex exits non-zero or returns invalid JSON.
- stderr is not surfaced as user-facing output; keep detailed operational logs server-side and redacted.
- This adapter exists, but it is not yet wired into the production worker or deployed.

`CodexAuthProbe` is also available for readiness integration. It runs the same sanitized `codex login status` command and accepts only a successful ChatGPT login status. The current server still reports `CODEX_AUTH_UNAVAILABLE` without executing the probe; wire the probe into `/ready` only after Codex CLI is installed on the target server and Ivy has completed interactive login there.

The meeting summarizer adapter is `src/adapters/codex-summarizer.ts`. It implements the existing `MeetingSummarizer` port and sends minute metadata plus transcript to the Codex JSON executor with a fixed meeting-summary output schema. The adapter then re-validates the result with the application Zod schema before worker persistence.

`CODEX_SUMMARIZER_MODE` defaults to `fake`. Set it to `codex` only after the production worker wiring and server-local Codex login have been explicitly approved and tested.

The server composition now creates the selected meeting summarizer and the Feishu SDK reader/delivery integration at startup, but the production durable-job consumer is still intentionally not started. `/ready` must continue to block Feishu webhook activation until real Feishu reading, real delivery, worker consumption, and Codex auth probing are wired together.

## Feishu Adapter Boundary

The app boundary for real Feishu integration is `src/adapters/feishu.ts`.

It deliberately exposes a small internal `FeishuApiClient` shape instead of letting SDK response types spread through the worker:

- `getMinuteBasicInfo(minuteId)`
- `exportMinuteTranscript(minuteId)`
- `sendTextMessage({ chatId, text })`

The adapter converts those calls into:

- `FeishuMinutesReaderAdapter`, used by the meeting worker.
- `FeishuMessageDeliveryAdapter`, used by pending outbox delivery.
- `deliverPendingMeetingSummaries`, which sends pending meeting summaries and acknowledges the real Feishu message ID back into SQLite.

The official SDK package is `@larksuiteoapi/node-sdk`. The local skeleton in `src/adapters/feishu-sdk.ts` now pins these call sites without making any startup network request:

- Self-built app client creation with `appId`, `appSecret`, `AppType.SelfBuild`, and `Domain.Feishu`.
- Text delivery through `client.im.message.create` with `receive_id_type=chat_id`.
- Minute basic info through `client.minutes.v1.minute.get`.
- Minute transcript retrieval through `client.minutes.v1.minuteTranscript.get`.

The SDK transcript API returns a binary stream. `src/adapters/minute-transcript-parser.ts` parses JSON transcript streams into the internal `TranscriptSegment[]` format and fails closed on invalid speaker/time/text fields. If the real Feishu transcript file format differs during integration, update this parser and its fixture tests rather than changing the worker contract.

`src/composition/feishu.ts` now wires the official SDK client into the internal `FeishuMinutesReaderAdapter` and `FeishuMessageDeliveryAdapter`. This is local dependency composition only: server startup can construct the objects, but no Feishu network call is made until a worker or delivery path invokes them.

This Feishu integration is still not connected to the production meeting worker or readiness probes. Wire it only when real credentials are present in `/opt/feishu-codex/secrets/bridge.env` and Ivy has approved a real Feishu integration step.

## Edge Nginx Direction

The Bridge workspace must stay separate from `/root/RealAgentAI_cc`.

Short term, the existing `realagent-nginx` may still be the only process bound to public `80/443`, so it can act as a shared edge gateway. Longer term, move edge config into a neutral workspace such as:

```text
/opt/aijia-edge-nginx
```

Then both RealAgent and Feishu Codex become upstream services behind that edge layer.

## Phase 1D Project-aware Follow-ups

The SQLite Project Registry is seeded with nine active projects: `FeishuAdaptor`,
`OpenMontage`, `aijia-landingpage`, `RealAgentAI_cc`,
`ljhooker-audiobooks`, `ivy-xhs`, `James公众号`, `family-first-ai-os`, and
`aijia-compass-work`. The initial aliases and mapping rules come from Ivy's
confirmed project list, including the explicitly supplied local-path hints and
the first-round mappings for Amy, B-roll, landing page, compass, and content
projects.

The designated Feishu context source is the approved group
`oc_a84d5b6ca478220d0a37964b50776edb`. This records the intended source
boundary only; it does not authorize or start a context sync. Context sync is
disabled by default and requires a separate Ivy-approved production change
before it is run.

The cloud worker cannot read Ivy's Mac paths directly. A production project
card must therefore use a server checkout, GitHub, or an explicitly approved
synced snapshot; a `local_path_hint` is not an executable cloud filesystem
path.

Phase 1D maps meeting follow-ups to project metadata and stores a projectized
Prompt. It does not create or run a Codex task, and every generated Todo stays
`proposed` until a separate Ivy-approved action authorizes it.

`GET /diag/projects` is a read-only aggregate diagnostic for active/archived
projects, active rules, context-snapshot counts/timestamps, and open mapping
conflicts. It must not expose raw group messages, file text, transcripts,
tokens, environment values, or secrets.

## Phase 1E Enterprise Context rollout boundary

Phase 1E adds an immutable Context source/evidence/candidate/review/record-version
schema and a separate `extract_context_candidates` durable job. This is a local
implementation boundary only; it has not been deployed or enabled in production.

Both production switches must remain off until Ivy approves a separate rollout:

```text
CONTEXT_CANDIDATES_ENABLED=false
CONTEXT_REVIEW_ENABLED=false
```

Before enabling either switch, the production change must include a SQLite backup,
additive migration audit, rollback procedure, Ivy private-card callback verification,
and an explicit decision for transcript retention period, deletion workflow, access
control, and encryption at rest. Enabling Context candidates does not authorize
historical group sync; `PROJECT_CONTEXT_SYNC_ENABLED` remains independently false.

`GET /diag/context` is aggregate-only. It exposes counts and the latest source capture
timestamp, never normalized source content, evidence excerpts, locators, open IDs,
tokens, or candidate payloads.

The first-slice limits are intentionally separate and must pass startup validation:
the immutable transcript snapshot defaults to `2000000` UTF-8 bytes / `10000`
segments, while extractor input defaults to `500000` UTF-8 bytes / `2000` segments.
The extractor limits cannot exceed the source limits. Inputs beyond either boundary
are never truncated; they produce a typed Context-only failure so the Phase 1D
summary and follow-up path can continue.
