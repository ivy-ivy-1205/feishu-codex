import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { MinuteContext } from '../src/ports/feishu.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { processMinuteJob } from '../src/services/meeting-worker.js';
import { ContextCaptureError } from '../src/services/context-source-capture.js';

const minute: MinuteContext = {
  minuteId: 'min-context-1', title: 'Context isolation',
  startedAt: '2026-08-03T01:00:00.000Z', endedAt: '2026-08-03T01:30:00.000Z',
  transcript: [{ speakerName: 'Ivy', startMs: 0, endMs: 1000, text: '决定进入第一实现切片。' }]
};

async function run(contextEnabled: boolean, failAt?: 'source' | 'enqueue' | 'database' | 'oversize') {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const jobs = new JobRepository(database.client);
  const meetings = new MeetingRepository(database.client);
  const sources = new ContextSourceRepository(database.client);
  meetings.ingestMinute({ minuteId: minute.minuteId, eventId: 'evt-context-1' });
  jobs.enqueueProcessMinute(minute.minuteId);
  const job = jobs.leaseNextProcessMinute(new Date('2030-01-01T00:00:00.000Z'))!;
  if (failAt === 'source') {
    sources.saveSource = () => { throw new ContextCaptureError('CONTEXT_SOURCE_CAPTURE_FAILED'); };
  }
  if (failAt === 'enqueue') {
    jobs.enqueueContextExtraction = () => { throw new ContextCaptureError('CONTEXT_JOB_ENQUEUE_FAILED'); };
  }
  if (failAt === 'database') {
    sources.saveSource = () => {
      throw Object.assign(new Error('database is readonly'), { code: 'SQLITE_READONLY' });
    };
  }
  const result = await processMinuteJob(job, {
    reader: { async getMinute() { return minute; } },
    summarizer: { async summarize() { return { oneLineConclusion: '现有纪要继续成功。', progress: [], decisions: [], risks: [], todos: [{
      title: '整理修复证据', description: '保留 Phase 1D follow-up', risk: 'low' as const,
      capability: 'content_draft' as const, projectKey: 'feishu-adaptor', subprojectKey: null,
      projectConfidence: 'high' as const, projectEvidence: '明确 Phase 1E', projectPrompt: '整理证据'
    }] }; } },
    meetingRepository: meetings, jobRepository: jobs,
    outboxRepository: new OutboxRepository(database.client), targetChatId: 'oc_ivy',
    now: () => new Date('2030-01-01T00:00:01.000Z'),
    context: contextEnabled ? { enabled: true, sourceRepository: sources,
      extractorVersion: 'phase1e-v1', promptVersion: 'context-v1',
      sourceMaxBytes: failAt === 'oversize' ? 1 : 2_000_000,
      sourceMaxSegments: 10_000 } : { enabled: false }
  });
  return { database, jobs, result, job };
}

describe('Phase 1D / Context capture isolation', () => {
  it('leaves Phase 1D behavior unchanged when the flag is off', async () => {
    const { database, result } = await run(false);
    expect(result).toBe('completed');
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_sources').get()).toEqual({ count: 0 });
    expect(database.client.prepare(`SELECT COUNT(*) AS count FROM batch_jobs WHERE type = 'extract_context_candidates'`).get()).toEqual({ count: 0 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_summaries').get()).toEqual({ count: 1 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_todos').get()).toEqual({ count: 1 });
  });

  it('captures one immutable source and one independent job before completing the summary', async () => {
    const { database, jobs, result } = await run(true);
    expect(result).toBe('completed');
    expect(database.client.prepare(`SELECT logical_key, source_version FROM context_sources`).get())
      .toEqual({ logical_key: 'feishu:minute:min-context-1:transcript', source_version: 1 });
    expect(jobs.list()).toContainEqual(expect.objectContaining({
      kind: 'extract_context_candidates', sourceId: expect.stringMatching(/^ctxsrc_/), attempt: 0
    }));
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_summaries').get()).toEqual({ count: 1 });
  });

  it.each([
    ['source', 'CONTEXT_SOURCE_CAPTURE_FAILED'],
    ['enqueue', 'CONTEXT_JOB_ENQUEUE_FAILED']
  ] as const)('isolates a Context-only %s failure and rolls back the whole capture transaction', async (failAt, code) => {
    const { database, result, job } = await run(true, failAt);
    expect(result).toBe('completed');
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_summaries').get()).toEqual({ count: 1 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_todos').get()).toEqual({ count: 1 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_sources').get()).toEqual({ count: 0 });
    expect(database.client.prepare(`SELECT COUNT(*) AS count FROM batch_jobs WHERE type = 'extract_context_candidates'`).get())
      .toEqual({ count: 0 });
    const stored = database.client.prepare(`SELECT status, payload FROM batch_jobs WHERE stable_key = ?`).get(job.key) as {
      status: string; payload: string
    };
    expect(stored.status).toBe('completed');
    expect(JSON.parse(stored.payload)).toMatchObject({ contextFailureCode: code });
    expect(stored.payload).not.toContain(minute.transcript[0]!.text);
  });

  it('preserves the original meeting failure semantics for a shared database failure', async () => {
    await expect(run(true, 'database')).rejects.toMatchObject({ code: 'SQLITE_READONLY' });
  });

  it('keeps Phase 1D successful when the transcript exceeds the Context source limit', async () => {
    const { database, result, job } = await run(true, 'oversize');
    expect(result).toBe('completed');
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_summaries').get()).toEqual({ count: 1 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_todos').get()).toEqual({ count: 1 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_sources').get()).toEqual({ count: 0 });
    const stored = database.client.prepare(`SELECT payload FROM batch_jobs WHERE stable_key = ?`).get(job.key) as { payload: string };
    expect(JSON.parse(stored.payload)).toMatchObject({ contextFailureCode: 'CONTEXT_SOURCE_BYTES_EXCEEDED' });
  });
});
