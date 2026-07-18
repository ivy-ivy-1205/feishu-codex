import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { MinuteContext, FeishuMinutesReader } from '../src/ports/feishu.js';
import type {
  MeetingSummarizer,
  MeetingSummaryDraft
} from '../src/ports/summarizer.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { processMinuteJob } from '../src/services/meeting-worker.js';

const ivyChatId = 'oc_d851c3e986007dc0f97ab582bcb2e7c8';
const now = new Date('2030-07-18T03:00:00.000Z');
const minuteFixture = JSON.parse(
  readFileSync(new URL('../src/fixtures/minute-transcript.json', import.meta.url), 'utf8')
) as MinuteContext;

const summaryDraft: MeetingSummaryDraft = {
  coreInsights: [
    'Phase 1A 仅验证本地 fixture 闭环',
    '转录未就绪必须安全重试',
    'Todo 只生成，不自动执行'
  ],
  confirmedDecisions: ['不连接真实飞书或 Codex'],
  risks: ['妙记转录可能暂未就绪'],
  todos: [
    {
      title: '整理核心信息',
      description: '整理本次会议的三条核心信息',
      risk: 'low',
      capability: 'content_draft'
    },
    {
      title: '起草用户提示',
      description: '起草转录未就绪时的用户提示',
      risk: 'low',
      capability: 'content_draft'
    },
    {
      title: '生成验收清单',
      description: '生成 Phase 1A 验收清单',
      risk: 'low',
      capability: 'content_draft'
    }
  ]
};

describe('processMinuteJob', () => {
  it('persists one structured summary and numbered todos', async () => {
    const harness = createHarness();

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    const result = readResult(harness.client);
    if (!result.summary) {
      throw new Error('expected a persisted structured summary');
    }
    expect(result.summary.coreInsights).toHaveLength(3);
    expect(result.todos.map((todo) => todo.displayedNumber)).toEqual([1, 2, 3]);
    expect(result.outbox[0]?.kind).toBe('ivy_meeting_summary');
    expect(result.outbox[0]?.targetChatId).toBe(ivyChatId);
    expect(result.jobStatus).toBe('completed');
  });

  it('retries without sending when the transcript is not ready', async () => {
    const harness = createHarness({ readerErrorCode: 'MINUTE_NOT_READY' });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('retry');

    const result = readResult(harness.client);
    expect(result.jobStatus).toBe('retry');
    expect(result.summaryCount).toBe(0);
    expect(result.outbox).toHaveLength(0);
  });

  it('does not create duplicate summaries when a completed lease is replayed', async () => {
    const harness = createHarness();

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');
    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('lost_lease');

    const result = readResult(harness.client);
    expect(result.summaryCount).toBe(1);
    expect(result.todoCount).toBe(3);
    expect(result.outboxCount).toBe(1);
  });

  it('recovers after persistence commits but job completion crashes', async () => {
    const harness = createHarness();
    const jobRepository = harness.dependencies.jobRepository;
    const markCompleted = jobRepository.markCompleted.bind(jobRepository);
    jobRepository.markCompleted = () => {
      throw new Error('simulated crash before job completion');
    };

    await expect(processMinuteJob(harness.job, harness.dependencies))
      .rejects.toThrow('simulated crash before job completion');
    expect(readResult(harness.client)).toMatchObject({
      jobStatus: 'processing',
      summaryCount: 1,
      todoCount: 3,
      outboxCount: 1
    });

    jobRepository.markCompleted = markCompleted;
    const reclaimAt = new Date(harness.job.leaseExpiresAt ?? 'invalid');
    const reclaimedJob = jobRepository.leaseNextProcessMinute(reclaimAt);
    if (!reclaimedJob) {
      throw new Error('expected the crashed job to be reclaimed after lease expiry');
    }
    harness.dependencies.now = () => reclaimAt;

    expect(await processMinuteJob(reclaimedJob, harness.dependencies)).toBe('completed');
    expect(readResult(harness.client)).toMatchObject({
      jobStatus: 'completed',
      summaryCount: 1,
      todoCount: 3,
      outboxCount: 1
    });
  });

  it('retries within budget with capped exponential backoff', async () => {
    const harness = createHarness({ readerErrorCode: 'MINUTE_NOT_READY', attempt: 6 });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('retry');

    const row = harness.client.prepare(`
      SELECT status, updated_at FROM batch_jobs WHERE stable_key = ?
    `).get(harness.job.key) as { status: string; updated_at: string };
    expect(row).toEqual({
      status: 'retry',
      updated_at: '2030-07-18T03:01:00.000Z'
    });
  });

  it('fails MINUTE_NOT_READY after its finite retry budget', async () => {
    const harness = createHarness({ readerErrorCode: 'MINUTE_NOT_READY', attempt: 7 });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    expect(readJob(harness.client)).toMatchObject({
      status: 'failed',
      payload: {
        attempt: 8,
        failureReason: 'MINUTE_NOT_READY_RETRY_EXHAUSTED'
      }
    });
    expect(readResult(harness.client)).toMatchObject({
      summaryCount: 0,
      outboxCount: 0
    });
  });

  it('fails RATE_LIMITED after its finite retry budget', async () => {
    const harness = createHarness({ readerErrorCode: 'RATE_LIMITED', attempt: 4 });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    expect(readJob(harness.client)).toMatchObject({
      status: 'failed',
      payload: {
        attempt: 5,
        failureReason: 'RATE_LIMITED_RETRY_EXHAUSTED'
      }
    });
  });

  it('continues retry attempts after SQLite close and reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aijia-worker-restart-'));
    const filename = join(directory, 'bridge.sqlite');
    try {
      let database = createSqliteDatabase(filename);
      migrateDatabase(database.client);
      let meetingRepository = new MeetingRepository(database.client);
      let jobRepository = new JobRepository(database.client);
      meetingRepository.ingestMinute({ minuteId: minuteFixture.minuteId, eventId: 'evt_restart' });
      jobRepository.enqueueProcessMinute(minuteFixture.minuteId);

      for (let expectedAttempt = 1; expectedAttempt <= 5; expectedAttempt += 1) {
        const availableAt = expectedAttempt === 1
          ? now
          : new Date((readRawJob(database.client).updated_at));
        const job = jobRepository.leaseNextProcessMinute(availableAt);
        if (!job) {
          throw new Error(`expected retry attempt ${expectedAttempt}`);
        }
        const result = await processMinuteJob(job, {
          reader: {
            async getMinute() {
              throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' });
            }
          },
          summarizer: { async summarize() { return summaryDraft; } },
          meetingRepository,
          jobRepository,
          outboxRepository: new OutboxRepository(database.client),
          targetChatId: ivyChatId,
          now: () => availableAt
        });
        expect(result).toBe(expectedAttempt < 5 ? 'retry' : 'completed');

        database.close();
        database = createSqliteDatabase(filename);
        migrateDatabase(database.client);
        meetingRepository = new MeetingRepository(database.client);
        jobRepository = new JobRepository(database.client);
      }

      expect(readJob(database.client)).toMatchObject({
        status: 'failed',
        payload: { attempt: 5, failureReason: 'RATE_LIMITED_RETRY_EXHAUSTED' }
      });
      expect(readResult(database.client)).toMatchObject({ summaryCount: 0, outboxCount: 0 });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reclaims a job after its worker lease expires', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const meetingRepository = new MeetingRepository(database.client);
    const jobRepository = new JobRepository(database.client);
    meetingRepository.ingestMinute({ minuteId: minuteFixture.minuteId, eventId: 'evt_fixture_1' });
    jobRepository.enqueueProcessMinute(minuteFixture.minuteId);

    expect(jobRepository.leaseNextProcessMinute(now)?.key).toBe(`minute:${minuteFixture.minuteId}`);
    expect(jobRepository.leaseNextProcessMinute(new Date(now.getTime() + 179_999))).toBeNull();
    expect(jobRepository.leaseNextProcessMinute(new Date(now.getTime() + 180_000))?.key)
      .toBe(`minute:${minuteFixture.minuteId}`);
  });

  it('raises an explicit LeaseLost error when a status CAS misses', () => {
    const harness = createHarness();
    const leaseExpiry = new Date(harness.job.leaseExpiresAt ?? 'invalid');

    expect(() => harness.dependencies.jobRepository.markCompleted(
      harness.job,
      leaseExpiry
    )).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    expect(readJobStatus(harness.client)).toBe('processing');
  });

  it('prevents an expired worker from persisting or completing a reclaimed job', async () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const meetingRepository = new MeetingRepository(database.client);
    const jobRepository = new JobRepository(database.client);
    meetingRepository.ingestMinute({ minuteId: minuteFixture.minuteId, eventId: 'evt_fixture_1' });
    jobRepository.enqueueProcessMinute(minuteFixture.minuteId);

    const expiredLease = jobRepository.leaseNextProcessMinute(now);
    const currentLease = jobRepository.leaseNextProcessMinute(new Date(now.getTime() + 180_000));
    if (!expiredLease || !currentLease) {
      throw new Error('expected both original and reclaimed leases');
    }
    await processMinuteJob(expiredLease, {
      reader: { async getMinute() { return minuteFixture; } },
      summarizer: { async summarize() { return summaryDraft; } },
      meetingRepository,
      jobRepository,
      outboxRepository: new OutboxRepository(database.client),
      targetChatId: ivyChatId,
      now: () => new Date(now.getTime() + 180_001)
    });

    expect(readJobStatus(database.client)).toBe('processing');
    expect(readResult(database.client).summaryCount).toBe(0);
    expect(readResult(database.client).outboxCount).toBe(0);
  });

  it('prevents an expired but unreclaimed worker from persisting or completing', async () => {
    const harness = createHarness();
    harness.dependencies.now = leaseExpiryClock(harness.job);

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('lost_lease');

    const result = readResult(harness.client);
    expect(result.jobStatus).toBe('processing');
    expect(result.summaryCount).toBe(0);
    expect(result.outboxCount).toBe(0);
  });

  it('prevents an expired worker from rescheduling a retry', async () => {
    const harness = createHarness({ readerErrorCode: 'MINUTE_NOT_READY' });
    harness.dependencies.now = leaseExpiryClock(harness.job);

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('lost_lease');

    expect(readJobStatus(harness.client)).toBe('processing');
    expect(readResult(harness.client).outboxCount).toBe(0);
  });

  it('prevents an expired worker from recording a permanent failure', async () => {
    const harness = createHarness({
      summary: { ...summaryDraft, coreInsights: [] }
    });
    harness.dependencies.now = leaseExpiryClock(harness.job);

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('lost_lease');

    expect(readJobStatus(harness.client)).toBe('processing');
    expect(readResult(harness.client).outboxCount).toBe(0);
  });

  it('prevents an expired retry-budget worker from recording a terminal failure', async () => {
    const harness = createHarness({ readerErrorCode: 'RATE_LIMITED', attempt: 4 });
    harness.dependencies.now = leaseExpiryClock(harness.job);

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('lost_lease');

    expect(readJobStatus(harness.client)).toBe('processing');
    expect(readResult(harness.client)).toMatchObject({
      summaryCount: 0,
      outboxCount: 0
    });
  });

  it('permanently fails invalid summarizer output with a redacted reason', async () => {
    const harness = createHarness({
      summary: {
        ...summaryDraft,
        coreInsights: [],
        risks: ['secret transcript text must not be stored in the failure reason']
      }
    });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    const row = harness.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = ?
    `).get(harness.job.key) as { status: string; payload: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload)).toMatchObject({
      minuteId: minuteFixture.minuteId,
      failureReason: 'SUMMARIZER_OUTPUT_INVALID'
    });
    expect(row.payload).not.toContain('secret transcript');
    expect(readResult(harness.client).outbox).toHaveLength(0);
  });

  it('permanently fails a renderer-rejected capability without partial writes', async () => {
    const harness = createHarness({
      summary: {
        ...summaryDraft,
        todos: [
          {
            ...summaryDraft.todos[0]!,
            title: '未知能力任务',
            capability: 'unknown'
          },
          ...summaryDraft.todos.slice(1)
        ]
      }
    });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    const row = harness.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = ?
    `).get(harness.job.key) as { status: string; payload: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload)).toMatchObject({
      minuteId: minuteFixture.minuteId,
      failureReason: 'SUMMARY_RENDER_INVALID'
    });
    expect(row.payload).not.toContain('未知能力任务');
    expect(readResult(harness.client)).toMatchObject({
      summaryCount: 0,
      todoCount: 0,
      outboxCount: 0
    });
  });

  it('persists an honest summary when decisions, risks, and Todos are empty', async () => {
    const harness = createHarness({
      summary: {
        ...summaryDraft,
        confirmedDecisions: [],
        risks: [],
        todos: []
      }
    });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    const result = readResult(harness.client);
    expect(result.jobStatus).toBe('completed');
    expect(result.todoCount).toBe(0);
    expect(result.outbox[0]?.body).toContain('暂无可由 Codex 直接推进的事项');
  });

  it('fails oversized structured output before any summary transaction', async () => {
    const harness = createHarness({
      summary: {
        ...summaryDraft,
        todos: [{
          ...summaryDraft.todos[0]!,
          title: '界'.repeat(300)
        }]
      }
    });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');
    expect(readJob(harness.client)).toMatchObject({
      status: 'failed',
      payload: { failureReason: 'SUMMARIZER_OUTPUT_INVALID' }
    });
    expect(readResult(harness.client)).toMatchObject({
      summaryCount: 0,
      todoCount: 0,
      outboxCount: 0
    });
  });
});

function createHarness(options: {
  readerErrorCode?: 'MINUTE_NOT_READY' | 'RATE_LIMITED';
  summary?: MeetingSummaryDraft;
  attempt?: number;
} = {}) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const meetingRepository = new MeetingRepository(database.client);
  const jobRepository = new JobRepository(database.client);
  const outboxRepository = new OutboxRepository(database.client);
  meetingRepository.ingestMinute({ minuteId: minuteFixture.minuteId, eventId: 'evt_fixture_1' });
  jobRepository.enqueueProcessMinute(minuteFixture.minuteId);
  const job = jobRepository.leaseNextProcessMinute(now);
  if (!job) {
    throw new Error('expected a leased process_minute job');
  }
  job.attempt = options.attempt ?? job.attempt;

  const reader: FeishuMinutesReader = {
    async getMinute() {
      if (options.readerErrorCode) {
        throw Object.assign(new Error('reader unavailable'), { code: options.readerErrorCode });
      }
      return minuteFixture;
    }
  };
  const summarizer: MeetingSummarizer = {
    async summarize() {
      return options.summary ?? summaryDraft;
    }
  };

  return {
    client: database.client,
    job,
    dependencies: {
      reader,
      summarizer,
      meetingRepository,
      jobRepository,
      outboxRepository,
      targetChatId: ivyChatId,
      now: () => now
    }
  };
}

function readResult(client: Database.Database) {
  const summaryRows = client.prepare(`
    SELECT id, content FROM meeting_summaries ORDER BY created_at
  `).all() as Array<{ id: string; content: string }>;
  const todoRows = client.prepare(`
    SELECT displayed_number FROM meeting_todos ORDER BY displayed_number
  `).all() as Array<{ displayed_number: number }>;
  const outbox = new OutboxRepository(client).list();
  const job = client.prepare(`
    SELECT status FROM batch_jobs WHERE stable_key = ?
  `).get(`minute:${minuteFixture.minuteId}`) as { status: string };

  return {
    summary: summaryRows[0] ? JSON.parse(summaryRows[0].content) as MeetingSummaryDraft : null,
    summaryCount: summaryRows.length,
    todos: todoRows.map((todo) => ({ displayedNumber: todo.displayed_number })),
    todoCount: todoRows.length,
    outbox,
    outboxCount: outbox.length,
    jobStatus: job.status
  };
}

function readJobStatus(client: Database.Database): string {
  const row = client.prepare(`
    SELECT status FROM batch_jobs WHERE stable_key = ?
  `).get(`minute:${minuteFixture.minuteId}`) as { status: string };
  return row.status;
}

function readRawJob(client: Database.Database): {
  status: string;
  payload: string;
  updated_at: string;
} {
  return client.prepare(`
    SELECT status, payload, updated_at FROM batch_jobs WHERE stable_key = ?
  `).get(`minute:${minuteFixture.minuteId}`) as {
    status: string;
    payload: string;
    updated_at: string;
  };
}

function readJob(client: Database.Database): {
  status: string;
  payload: Record<string, unknown>;
} {
  const row = readRawJob(client);
  return { status: row.status, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

function leaseExpiryClock(job: { leaseExpiresAt?: string }): () => Date {
  const leaseExpiresAt = job.leaseExpiresAt;
  if (!leaseExpiresAt) {
    throw new Error('expected a leased job with an expiry');
  }
  return () => new Date(leaseExpiresAt);
}
