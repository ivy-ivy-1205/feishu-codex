import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import * as backfill from '../src/services/founder-stream-backfill.js';
import * as cli from '../src/cli/backfill-founder-stream.js';
import type { FeishuContextClient, FeishuContextMessage } from '../src/services/feishu-context-sync.js';

const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';
const since = '2026-08-31T00:00:00.000Z';
const now = new Date('2026-09-20T00:00:00.000Z');
const databases: ReturnType<typeof createSqliteDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function repositories() {
  const db = createSqliteDatabase(':memory:');
  databases.push(db);
  migrateDatabase(db.client);
  return { db, sourceRepository: new ContextSourceRepository(db.client), jobRepository: new JobRepository(db.client) };
}
function message(messageId: string, changes: Partial<FeishuContextMessage> = {}): FeishuContextMessage {
  return { messageId, messageType: 'text', text: `PRIVATE CONTENT ${messageId}`, createdAt: '2026-09-01T00:00:00.000Z',
    senderId: 'ou_ivy', threadId: null, rootId: null, parentId: null, ...changes };
}
function fixture() {
  const requests: unknown[] = [];
  const feishu: FeishuContextClient = {
    async listMessages(input) {
      requests.push(input);
      return input.cursor === null
        ? { messages: [message('root1', { threadId: 'thread1' })], nextCursor: 'root2' }
        : { messages: [message('root2', { threadId: 'thread2' }), message('old', { createdAt: '2026-08-30T00:00:00.000Z' }), message('future', { createdAt: '2026-09-21T00:00:00.000Z' })], nextCursor: null };
    },
    async listThreadMessages(input) {
      requests.push(input);
      if (input.threadId === 'thread2') return { messages: [message('reply3', { threadId: 'thread2', rootId: 'root2' })], nextCursor: null };
      return input.cursor === null
        ? { messages: [message('root1', { threadId: 'thread1' }), message('reply1', { threadId: 'thread1', rootId: 'root1' })], nextCursor: 'reply2' }
        : { messages: [message('reply2', { threadId: 'thread1', rootId: 'root1', parentId: 'reply1', edited: true })], nextCursor: null };
    },
    async listReferencedFiles() { return []; }
  };
  return { feishu, requests };
}

describe('founder stream backfill', () => {
  it('requires an explicit exact window, pages roots and threads, deduplicates and persists immutable sources', async () => {
    const deps = repositories();
    const { feishu, requests } = fixture();
    const report = await backfill.runFounderStreamBackfill({ chatId, since, now, feishu, ...deps, dryRun: false });
    expect(report.requestedRange).toEqual({ since, until: now.toISOString() });
    expect(report.coverage).toMatchObject({ rootPages: 2, threadPages: 3, threadsDiscovered: 2 });
    expect(report.sourcesCaptured).toBe(5);
    expect(requests).toHaveLength(5);
    expect(requests.every((value) => (value as { since: Date }).since.toISOString() === since)).toBe(true);
    const sources = deps.sourceRepository.listSources().filter((source) => source.sourceType === 'group_message');
    expect(sources).toHaveLength(5);
    expect(sources.find((source) => source.externalId === 'reply2')).toMatchObject({
      authors: [{ openId: 'ou_ivy', displayName: null }], metadata: { threadId: 'thread1', rootId: 'root1', parentId: 'reply1', edited: true }
    });
    expect(deps.db.client.prepare('SELECT type FROM batch_jobs').all()).toEqual([{ type: 'analyze_founder_stream_batch' }]);
    await backfill.runFounderStreamBackfill({ chatId, since, now: new Date('2026-09-20T00:01:00.000Z'), feishu, ...deps, dryRun: false });
    expect(deps.sourceRepository.listSources().filter((source) => source.sourceType === 'group_message')).toHaveLength(5);
    expect(deps.db.client.prepare('SELECT type FROM batch_jobs').all()).toHaveLength(1);
  });

  it('defaults to dry-run and never writes sources, audit snapshots or jobs', async () => {
    const deps = repositories();
    const report = await backfill.runFounderStreamBackfill({ chatId, since, now, ...fixture(), ...deps });
    expect(report.dryRun).toBe(true);
    expect(report.sourcesCaptured).toBe(5);
    expect(deps.sourceRepository.listSources()).toEqual([]);
    expect(deps.db.client.prepare('SELECT * FROM batch_jobs').all()).toEqual([]);
  });

  it('rejects another chat or a missing/invalid window before reads', async () => {
    const { feishu, requests } = fixture();
    await expect(backfill.runFounderStreamBackfill({ chatId: 'oc_other', since, now, feishu })).rejects.toMatchObject({ code: 'FEISHU_CHAT_NOT_APPROVED' });
    for (const invalid of ['', 'yesterday', '2026-09-21T00:00:00.000Z']) {
      await expect(backfill.runFounderStreamBackfill({ chatId, since: invalid, now, feishu })).rejects.toThrow();
    }
    expect(requests).toEqual([]);
  });

  it('retains every failure, page cursor and policy gap instead of claiming completeness', async () => {
    const deps = repositories();
    const feishu: FeishuContextClient = {
      async listMessages() { return { messages: [message('root', { threadId: 'denied' }), message('video', { messageType: 'video' }), message('audio', { messageType: 'audio' }), message('voice', { messageType: 'voice', text: null }), message('deleted', { deleted: true }), message('file', { messageType: 'file', text: null })], nextCursor: 'loop' }; },
      async listThreadMessages() { throw new Error('sensitive remote error'); },
      async listReferencedFiles() { return [{ fileToken: 'f1', title: 'file', mimeType: 'application/pdf', text: null }]; }
    };
    const report = await backfill.runFounderStreamBackfill({ chatId, since, now, feishu, ...deps, dryRun: false });
    expect(report.coverageStatus).toBe('partial');
    expect(report.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['PAGINATION_CURSOR_REPEATED', 'THREAD_PAGE_UNAVAILABLE', 'MEDIA_SKIPPED', 'VOICE_TEXT_MISSING', 'MESSAGE_DELETED', 'FILE_TEXT_UNREADABLE']));
    expect(JSON.stringify(report)).not.toContain('sensitive remote error');
    expect(deps.sourceRepository.listSources().some((source) => source.sourceType === 'feishu_sync_coverage' && source.contentText.includes('loop'))).toBe(true);
    expect(deps.sourceRepository.listSources().some((source) => source.externalId === 'deleted' && source.sourceType === 'group_message')).toBe(false);
  });

  it('CLI requires a single explicit mode and prints aggregate counts without content or identifiers', async () => {
    for (const args of [[], ['--chat-id', chatId, '--since', since], ['--chat-id', chatId, '--since', since, '--dry-run', '--persist']]) {
      expect(() => cli.parseBackfillArguments(args)).toThrow();
    }
    const lines: string[] = [];
    const deps = repositories();
    await cli.runBackfillCli(['--', '--chat-id', chatId, '--since', since, '--dry-run'], { ...fixture(), ...deps, now, write: (line) => lines.push(line) });
    expect(JSON.parse(lines.join('')).sourcesCaptured).toBe(5);
    expect(lines.join('')).not.toContain('PRIVATE CONTENT');
    expect(lines.join('')).not.toContain('reply1');
    expect(deps.sourceRepository.listSources()).toEqual([]);
  });

  it('records root API failures and missing thread readers as partial audited runs', async () => {
    for (const failRoot of [true, false]) {
      const deps = repositories();
      const report = await backfill.runFounderStreamBackfill({ chatId, since, now, ...deps, dryRun: false, feishu: {
        async listMessages() {
          if (failRoot) throw new Error('remote failure');
          return { messages: [message('root', { threadId: 'missing-reader' })], nextCursor: null };
        },
        async listReferencedFiles() { throw new Error('file listing failed'); }
      } });
      expect(report.coverageStatus).toBe('partial');
      expect(report.sourceCoverage.termination).toBe('incomplete');
      expect(report.gaps.map((gap) => gap.code)).toContain(failRoot ? 'ROOT_PAGE_UNAVAILABLE' : 'THREAD_PAGE_UNAVAILABLE');
      expect(deps.sourceRepository.listSources().some((source) => source.sourceType === 'feishu_sync_coverage')).toBe(true);
    }
  });
});
