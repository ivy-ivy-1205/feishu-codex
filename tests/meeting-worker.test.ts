import { readFileSync } from 'node:fs';
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
      risk: 'low'
    },
    {
      title: '起草用户提示',
      description: '起草转录未就绪时的用户提示',
      risk: 'low'
    },
    {
      title: '生成验收清单',
      description: '生成 Phase 1A 验收清单',
      risk: 'low'
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

  it('does not create duplicate summaries on retry', async () => {
    const harness = createHarness();

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');
    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('completed');

    const result = readResult(harness.client);
    expect(result.summaryCount).toBe(1);
    expect(result.todoCount).toBe(3);
    expect(result.outboxCount).toBe(1);
  });

  it('retries rate limits with capped exponential backoff', async () => {
    const harness = createHarness({ readerErrorCode: 'RATE_LIMITED', attempt: 10 });

    expect(await processMinuteJob(harness.job, harness.dependencies)).toBe('retry');

    const row = harness.client.prepare(`
      SELECT status, updated_at FROM batch_jobs WHERE stable_key = ?
    `).get(harness.job.key) as { status: string; updated_at: string };
    expect(row).toEqual({
      status: 'retry',
      updated_at: '2030-07-18T03:01:00.000Z'
    });
  });

  it('reclaims a job after its worker lease expires', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const meetingRepository = new MeetingRepository(database.client);
    const jobRepository = new JobRepository(database.client);
    meetingRepository.ingestMinute({ minuteId: minuteFixture.minuteId, eventId: 'evt_fixture_1' });
    jobRepository.enqueueProcessMinute(minuteFixture.minuteId);

    expect(jobRepository.leaseNextProcessMinute(now)?.key).toBe(`minute:${minuteFixture.minuteId}`);
    expect(jobRepository.leaseNextProcessMinute(new Date(now.getTime() + 59_999))).toBeNull();
    expect(jobRepository.leaseNextProcessMinute(new Date(now.getTime() + 60_000))?.key)
      .toBe(`minute:${minuteFixture.minuteId}`);
  });

  it('prevents an expired worker from persisting or completing a reclaimed job', async () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const meetingRepository = new MeetingRepository(database.client);
    const jobRepository = new JobRepository(database.client);
    meetingRepository.ingestMinute({ minuteId: minuteFixture.minuteId, eventId: 'evt_fixture_1' });
    jobRepository.enqueueProcessMinute(minuteFixture.minuteId);

    const expiredLease = jobRepository.leaseNextProcessMinute(now);
    const currentLease = jobRepository.leaseNextProcessMinute(new Date(now.getTime() + 60_000));
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
      now: () => new Date(now.getTime() + 60_001)
    });

    expect(readJobStatus(database.client)).toBe('processing');
    expect(readResult(database.client).summaryCount).toBe(0);
    expect(readResult(database.client).outboxCount).toBe(0);
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
