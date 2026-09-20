import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { runFounderStreamBackfill } from '../src/services/founder-stream-backfill.js';
import * as health from '../src/routes/health.js';

const databases: ReturnType<typeof createSqliteDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';
const at = new Date('2026-09-21T00:00:00.000Z');
function setup() {
  const db = createSqliteDatabase(':memory:'); databases.push(db); migrateDatabase(db.client);
  const sources = new ContextSourceRepository(db.client), jobs = new JobRepository(db.client);
  const logs: string[] = [];
  const app = buildApp({ readiness: () => ({ ready: true }), verificationToken: 'private-secret', encryptKey: '',
    ingestMinute: () => ({ status: 'ignored' }), routeReply: () => ({ kind: 'reject', reason: 'wrong_chat' }),
    founderStreamDiagnostics: { client: db.client },
    logger: { stream: { write(line: string) { logs.push(line); } } } });
  return { db, sources, jobs, app, logs };
}
describe('founder stream diagnostics', () => {
  it('projects aggregate coverage, cursor state and queue counts without source content or identifiers', async () => {
    const h = setup();
    await runFounderStreamBackfill({ chatId: chat, since: '2026-09-01T00:00:00.000Z', now: at, dryRun: false,
      sourceRepository: h.sources, jobRepository: h.jobs, feishu: {
        async listMessages() { return { messages: [{ messageId: 'om_private', senderId: 'ou_private', senderType: 'user',
          messageType: 'text', text: 'secret meeting excerpt', createdAt: '2026-09-03T12:00:00.000Z' }], nextCursor: 'private-cursor' }; },
        async listReferencedFiles() { return []; }
      } });
    const response = await h.app.inject({ url: '/diag/founder-stream?token=private-secret' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      coverage: { snapshots: 1, latest: { requestedWindow: { since: '2026-09-01T00:00:00.000Z', until: at.toISOString() },
        observedWindow: { earliest: '2026-09-03T12:00:00.000Z', latest: '2026-09-03T12:00:00.000Z' }, status: 'partial',
        cursorState: { root: { present: true, count: 1, status: 'cursor_repeated' }, thread: { count: 0, present: false } } } },
      sources: { total: 3, byType: { group_message: 1, feishu_sync_coverage: 1, feishu_sync_gap: 1 }, byStatus: { available: 3 } },
      gapsByCode: { PAGINATION_CURSOR_REPEATED: 1 },
      jobs: { analyze_founder_stream_batch: { queued: 1, retry: 0 } },
      topicsByStage: { idea: 0, active_project: 0 }, openAlignmentIssues: { candidate: 0, ready: 0, asked: 0, total: 0 }
    });
    h.db.client.prepare("UPDATE batch_jobs SET status='retry'").run();
    const retried = (await h.app.inject({ url: '/diag/founder-stream' })).json();
    expect(retried.jobs.analyze_founder_stream_batch).toMatchObject({ queued: 0, retry: 1 });
    await h.app.close();
    for (const secret of ['secret meeting excerpt', 'private-cursor', 'ou_private', 'om_private', chat, 'private-secret', 'ctxsrc_']) {
      expect(response.body).not.toContain(secret); expect(h.logs.join('')).not.toContain(secret);
    }
  });
  it('reports thread recovery state without revealing thread cursors and accepts each known gap code', async () => {
    const h = setup();
    await runFounderStreamBackfill({ chatId: chat, since: '2026-09-01T00:00:00.000Z', now: at, dryRun: false,
      sourceRepository: h.sources, jobRepository: h.jobs, feishu: {
        async listMessages() { return { messages: [{ messageId: 'om_thread_root', senderId: 'ou_private', senderType: 'user',
          messageType: 'text', text: 'private thread text', threadId: 'private-thread-id', createdAt: '2026-09-03T12:00:00.000Z' }], nextCursor: null,
          gaps: [{ code: 'MESSAGE_INVALID', sourceRef: 'private-invalid-source', reason: 'private reason' }] }; },
        async listThreadMessages(input) { if (input.cursor) throw new Error('private error'); return { messages: [], nextCursor: 'private-thread-cursor' }; },
        async listReferencedFiles() { return []; }
      } });
    const response = await h.app.inject({ url: '/diag/founder-stream' });
    expect(response.json()).toMatchObject({ coverage: { latest: { cursorState: {
      root: { count: 0, present: false, status: 'read' }, thread: { count: 1, present: true, status: 'unavailable', lastUpdatedAt: at.toISOString() }
    } } }, gapsByCode: { MESSAGE_INVALID: 1, THREAD_PAGE_UNAVAILABLE: 1 } });
    expect(response.body).not.toContain('private'); await h.app.close(); expect(h.logs.join('')).not.toContain('private-thread');
  });
  it('fails closed on malformed audit JSON and unknown free-text labels', async () => {
    const h = setup();
    for (const [sourceType, contentText] of [['feishu_sync_coverage', '{bad private-data'], ['feishu_sync_gap', '{"code":"ou_private-secret"}'], ['ou_secret-type', 'sensitive']]) {
      h.sources.saveSource({ sourceSystem: 'feishu', sourceType: sourceType!, externalId: sourceType!, logicalKey: sourceType!,
        authors: [], locatorUri: null, occurredAt: at.toISOString(), capturedAt: at, contentFormat: 'text/plain', contentText: contentText!,
        metadata: {}, availabilityStatus: 'available' });
    }
    const response = await h.app.inject({ url: '/diag/founder-stream' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ coverage: { snapshots: 1, invalidSnapshots: 1, latest: null },
      gapsByCode: { UNKNOWN: 1 }, sources: { byType: { other: 1 } } });
    expect(response.body).not.toMatch(/private|sensitive|ou_secret/); await h.app.close();
  });
  it('distinguishes permission loss and unknown availability instead of treating them as readable', async () => {
    const h = setup();
    for (const availabilityStatus of ['permission_lost', 'unknown'] as const) h.sources.saveSource({ sourceSystem: 'feishu',
      sourceType: 'minute_transcript', externalId: availabilityStatus, logicalKey: availabilityStatus, occurredAt: at.toISOString(),
      capturedAt: at, authors: [], locatorUri: null, contentFormat: 'text/plain', contentText: 'private unavailable', metadata: {}, availabilityStatus });
    const response = await h.app.inject({ url: '/diag/founder-stream' });
    expect(response.json().sources.byStatus).toEqual({ permission_lost: 1, unknown: 1 }); await h.app.close();
  });
  it('returns a stable empty aggregate and never exposes database failure details', async () => {
    const h = setup();
    expect((await h.app.inject({ url: '/diag/founder-stream' })).json()).toMatchObject({ sources: { total: 0 }, coverage: { latest: null }, outbox: {} });
    h.db.client.exec('ALTER TABLE context_sources RENAME TO private_secret_table');
    const response = await h.app.inject({ url: '/diag/founder-stream' });
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: 'FOUNDER_STREAM_DIAGNOSTICS_UNAVAILABLE' });
    await h.app.close(); expect(h.logs.join('')).not.toContain('private_secret_table');
  });
});

describe('enabled pipeline readiness', () => {
  it.each([
    [false, true, false, false, true], [false, true, true, true, true],
    [true, false, false, true, true], [false, false, false, false, false]
  ])('meeting=%s capture=%s analysis=%s auth=%s is ready=%s', async (meetingEnabled, captureEnabled, analysisEnabled, auth, ready) => {
    const check = health.createPipelineReadiness({ checkDatabase: () => {}, meetingEnabled,
      founderFlags: { captureEnabled, analysisEnabled, groupDeliveryEnabled: false },
      meetingConsumerAvailable: () => meetingEnabled, founderConsumerAvailable: () => captureEnabled,
      meetingCodexRequired: true, isCodexAuthAvailable: () => auth });
    expect((await check()).ready).toBe(ready);
  });
  it('does not hide a failed founder consumer or required Codex auth', async () => {
    for (const [consumer, auth] of [[false, true], [true, false]]) {
      const status = await health.createPipelineReadiness({ checkDatabase: () => {}, meetingEnabled: false,
        founderFlags: { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false },
        meetingConsumerAvailable: () => false, founderConsumerAvailable: () => consumer!, meetingCodexRequired: false,
        isCodexAuthAvailable: () => auth! })();
      expect(status.ready).toBe(false);
    }
  });
});
