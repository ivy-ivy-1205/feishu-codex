import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { ReplyDecision } from '../src/domain/authorization.js';
import type { MinuteContext } from '../src/ports/feishu.js';
import type { MeetingSummaryDraft } from '../src/ports/summarizer.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import {
  OutboxRepository,
  type IvyMeetingSummaryMessage
} from '../src/repositories/outbox-repository.js';
import { processMinuteJob } from '../src/services/meeting-worker.js';
import { ingestMinuteGenerated } from '../src/services/minute-ingestion.js';
import { routeReply } from '../src/services/reply-router.js';
import { createMeetingLoopFixture } from './helpers/meeting-loop-fixture.js';

const verificationToken = 'fixture-verification-token';
const ivyPrivateChatId = 'oc_d851c3e986007dc0f97ab582bcb2e7c8';
const deliveredMessageId = 'om_fixture_meeting_summary_1';
const workerNow = new Date('2030-07-18T03:00:00.000Z');

const minuteEventFixture = JSON.parse(readFileSync(
  new URL('../src/fixtures/minute-generated.json', import.meta.url),
  'utf8'
)) as Record<string, unknown>;
const minuteContextFixture = JSON.parse(readFileSync(
  new URL('../src/fixtures/minute-transcript.json', import.meta.url),
  'utf8'
)) as MinuteContext;
const summaryFixture: MeetingSummaryDraft = {
  oneLineConclusion: 'Phase 1A 仅验证本地 fixture 闭环，Todo 只生成不自动执行。',
  progress: [
    'Phase 1A 仅验证本地 fixture 闭环',
    '转录未就绪必须安全重试',
    'Todo 只生成，不自动执行'
  ],
  decisions: ['不连接真实飞书或 Codex'],
  risks: ['妙记转录可能暂未就绪'],
  todos: [
    {
      title: '整理核心信息',
      description: '整理本次会议的三条核心信息',
      risk: 'low',
      capability: 'content_draft',
      projectKey: null,
      subprojectKey: null,
      projectConfidence: 'low',
      projectEvidence: '会议没有足够证据',
      projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
    },
    {
      title: '起草用户提示',
      description: '起草转录未就绪时的用户提示',
      risk: 'low',
      capability: 'content_draft',
      projectKey: null,
      subprojectKey: null,
      projectConfidence: 'low',
      projectEvidence: '会议没有足够证据',
      projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
    },
    {
      title: '生成验收清单',
      description: '生成 Phase 1A 验收清单',
      risk: 'low',
      capability: 'content_draft',
      projectKey: null,
      subprojectKey: null,
      projectConfidence: 'low',
      projectEvidence: '会议没有足够证据',
      projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
    }
  ]
};

interface DeliveredSummary extends IvyMeetingSummaryMessage {
  body: string;
  meeting: Pick<MinuteContext, 'title' | 'startedAt' | 'endedAt'>;
  messageId: string;
}

const openHarnesses: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

describe('meeting-to-Todo Phase 1A acceptance loop', () => {
  it('turns one minute fixture into a private summary and routes Ivy Todo 1', async () => {
    const harness = await createMeetingLoopHarness();

    expect(await harness.postMinuteFixture()).toEqual({ status: 'accepted' });
    expect(harness.jobs()).toMatchObject([{
      kind: 'process_minute',
      key: 'minute:min_fixture_1'
    }]);

    await harness.runOneWorkerCycle();
    const summary = harness.outbox.single();
    expect(summary).toMatchObject({
      targetChatId: ivyPrivateChatId,
      messageId: deliveredMessageId,
      meeting: {
        title: minuteContextFixture.title,
        startedAt: minuteContextFixture.startedAt,
        endedAt: minuteContextFixture.endedAt
      }
    });
    expect(summary.body).toContain(`${minuteContextFixture.title}｜会后行动摘要`);
    expect(summary.body).toContain('北京时间：2026-07-18 10:00–10:30');
    expect(summary.body).toContain('悉尼时间：2026-07-18 12:00–12:30');
    expect(summary.body).toContain('一句话结论');
    expect(summary.body).toContain('进展');
    expect(summary.body).toContain('已确认');
    expect(summary.body).toContain('风险/卡点');
    expect(summary.body).toContain('我可以帮你推进');
    expect(summary.todos[0]?.capability).toBe('content_draft');

    const durable = await harness.restartAfterDelivery();
    expect(durable).toEqual({
      jobStatus: 'completed',
      summaryCount: 1,
      todoCount: 3,
      outboxCount: 1,
      outboxStatus: 'delivered',
      deliveredAt: workerNow.toISOString(),
      summaryMessageId: deliveredMessageId
    });

    harness.confirmIvyOpenId('ou_ivy_fixture');
    const decision = await harness.reply({
      openId: 'ou_ivy_fixture',
      replyTo: summary.messageId,
      text: '先干 1'
    });
    expect(decision.kind).toBe('authorize_low_risk');
    if (decision.kind !== 'authorize_low_risk') {
      throw new Error(`expected authorization, received ${decision.kind}`);
    }
    expect(decision.todoId).toBe('todo:min_fixture_1:1');
    expect(decision.todo.displayedNumber).toBe(1);
    expect(decision.todo.capability).toBe('content_draft');
  });
});

async function createMeetingLoopHarness() {
  const fixture = createMeetingLoopFixture();
  const { temporaryDirectory, databaseFilename } = fixture;
  let { database, meetingRepository, jobRepository, outboxRepository } = fixture;
  const approverOpenIds: string[] = [];
  const deliveredSummaries: DeliveredSummary[] = [];
  const buildHarnessApp = () => buildApp({
    readiness: () => ({ ready: false, reason: 'WORKER_UNAVAILABLE' }),
    verificationToken,
    encryptKey: 'encrypt-test-key',
    ingestMinute: (event) => ingestMinuteGenerated(event, {
      meetingRepository,
      jobRepository
    }),
    routeReply: (input) => routeReply(input, {
      meetingRepository,
      ivyPrivateChatId,
      approverOpenIds
    }),
    logger: false
  });
  let app = buildHarnessApp();

  let closed = false;
  const harness = {
    async postMinuteFixture() {
      const header = minuteEventFixture.header as Record<string, unknown>;
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/feishu/events',
        payload: {
          ...minuteEventFixture,
          header: { ...header, token: verificationToken }
        }
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ status: string }>();
    },
    jobs: () => jobRepository.list(),
    async runOneWorkerCycle() {
      const job = jobRepository.leaseNextProcessMinute(workerNow);
      if (!job) {
        throw new Error('expected one durable minute job');
      }
      await processMinuteJob(job, {
        reader: {
          async getMinute(minuteId) {
            if (minuteId !== minuteContextFixture.minuteId) {
              throw new Error(`unknown fixture minute ${minuteId}`);
            }
            return minuteContextFixture;
          }
        },
        summarizer: {
          async summarize(context) {
            if (context.minuteId !== minuteContextFixture.minuteId) {
              throw new Error(`unexpected summary context ${context.minuteId}`);
            }
            return summaryFixture;
          }
        },
        meetingRepository,
        jobRepository,
        outboxRepository,
        targetChatId: ivyPrivateChatId,
        now: () => workerNow
      });

      const outgoing = outboxRepository.list();
      if (outgoing.length !== 1 || !outgoing[0]) {
        throw new Error(`expected one summary outbox message, received ${outgoing.length}`);
      }
      outboxRepository.acknowledgeMeetingSummaryDelivery({
        minuteId: minuteContextFixture.minuteId,
        messageId: deliveredMessageId,
        deliveredAt: workerNow
      });
      deliveredSummaries.push({
        ...outgoing[0],
        messageId: deliveredMessageId
      } as DeliveredSummary);
    },
    outbox: {
      single() {
        if (deliveredSummaries.length !== 1 || !deliveredSummaries[0]) {
          throw new Error(`expected one delivered summary, received ${deliveredSummaries.length}`);
        }
        return deliveredSummaries[0];
      }
    },
    async restartAfterDelivery() {
      await app.close();
      database.close();
      database = createSqliteDatabase(databaseFilename);
      migrateDatabase(database.client);
      meetingRepository = new MeetingRepository(database.client);
      jobRepository = new JobRepository(database.client);
      outboxRepository = new OutboxRepository(database.client);
      app = buildHarnessApp();

      const job = database.client.prepare(`
        SELECT status FROM batch_jobs WHERE stable_key = 'minute:min_fixture_1'
      `).get() as { status: string };
      const summary = database.client.prepare(`
        SELECT summary_message_id FROM meeting_summaries WHERE minute_id = 'min_fixture_1'
      `).get() as { summary_message_id: string };
      const summaryCount = database.client.prepare(`
        SELECT COUNT(*) AS count FROM meeting_summaries
      `).get() as { count: number };
      const todoCount = database.client.prepare(`
        SELECT COUNT(*) AS count FROM meeting_todos
      `).get() as { count: number };
      const outbox = database.client.prepare(`
        SELECT status, delivered_at FROM outbox
        WHERE idempotency_key = 'minute-summary:min_fixture_1'
      `).get() as { status: string; delivered_at: string | null };
      const outboxCount = database.client.prepare(`
        SELECT COUNT(*) AS count FROM outbox
      `).get() as { count: number };

      return {
        jobStatus: job.status,
        summaryCount: summaryCount.count,
        todoCount: todoCount.count,
        outboxCount: outboxCount.count,
        outboxStatus: outbox.status,
        deliveredAt: outbox.delivered_at,
        summaryMessageId: summary.summary_message_id
      };
    },
    confirmIvyOpenId(openId: string) {
      approverOpenIds.splice(0, approverOpenIds.length, openId);
    },
    async reply(input: { openId: string; replyTo: string; text: string }) {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/feishu/events',
        payload: replyEvent(input)
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        status: 'reply_decision';
        decision: ReplyDecision;
      }>();
      expect(body.status).toBe('reply_decision');
      return body.decision;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await app.close();
      database.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  };
  openHarnesses.push(harness);
  return harness;
}

function replyEvent(input: { openId: string; replyTo: string; text: string }) {
  return {
    schema: '2.0',
    header: {
      token: verificationToken,
      event_id: 'evt_reply_acceptance_1',
      event_type: 'im.message.receive_v1',
      create_time: '2030-07-18T03:01:00.000Z'
    },
    event: {
      sender: { sender_id: { open_id: input.openId } },
      message: {
        chat_id: ivyPrivateChatId,
        parent_id: input.replyTo,
        message_type: 'text',
        content: JSON.stringify({ text: input.text })
      }
    }
  };
}
