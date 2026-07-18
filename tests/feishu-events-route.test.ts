import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp, type AppDependencies } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { ingestMinuteGenerated } from '../src/services/minute-ingestion.js';
import { routeReply } from '../src/services/reply-router.js';

const verificationToken = 'verify-test-token';
const privateChatId = 'oc_d851c3e986007dc0f97ab582bcb2e7c8';
const minuteFixture = JSON.parse(
  readFileSync(new URL('../src/fixtures/minute-generated.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

describe('POST /webhooks/feishu/events', () => {
  it('echoes a verified Feishu URL verification challenge', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: {
        type: 'url_verification',
        token: verificationToken,
        challenge: 'challenge-token'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: 'challenge-token' });
    await harness.close();
  });

  it('rejects URL verification and events with a wrong token', async () => {
    const harness = createHarness();
    const verification = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: {
        type: 'url_verification',
        token: 'wrong-token',
        challenge: 'must-not-echo'
      }
    });
    const event = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: withEventToken(minuteFixture, 'wrong-token')
    });

    expect(verification.statusCode).toBe(401);
    expect(verification.json()).toEqual({ error: 'invalid_verification_token' });
    expect(event.statusCode).toBe(401);
    expect(harness.jobRepository.list()).toHaveLength(0);
    await harness.close();
  });

  it('acknowledges a valid minute event without running a worker inline', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: withEventToken(minuteFixture, verificationToken)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'accepted' });
    expect(harness.workerCalls).toBe(0);
    expect(harness.jobRepository.list()).toMatchObject([
      { kind: 'process_minute', key: 'minute:min_fixture_1' }
    ]);
    await harness.close();
  });

  it('keeps Feishu retries idempotent at the HTTP boundary', async () => {
    const harness = createHarness();
    const payload = withEventToken(minuteFixture, verificationToken);

    const first = await harness.app.inject({
      method: 'POST', url: '/webhooks/feishu/events', payload
    });
    const second = await harness.app.inject({
      method: 'POST', url: '/webhooks/feishu/events', payload
    });

    expect(first.json()).toEqual({ status: 'accepted' });
    expect(second.json()).toEqual({ status: 'duplicate' });
    expect(harness.jobRepository.list()).toHaveLength(1);
    await harness.close();
  });

  it('returns the existing fail-closed reply authorization decision', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: privateChatId,
        replyTo: 'om_unacknowledged_summary',
        text: '先干 1'
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'reply_decision',
      decision: { kind: 'clarify', reason: 'todo_not_found' }
    });
    expect(harness.workerCalls).toBe(0);
    await harness.close();
  });

  it('passes through successful, wrong-chat, and non-Ivy authorization decisions', async () => {
    const harness = createHarness();
    seedDeliveredTodo(harness.meetingRepository);

    const authorized = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: privateChatId,
        replyTo: 'om_http_summary',
        text: '先干 1'
      })
    });
    const wrongChat = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: 'oc_wrong_chat',
        replyTo: 'om_http_summary',
        text: '先干 1'
      })
    });
    const nonIvy = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_not_ivy',
        chatId: privateChatId,
        replyTo: 'om_http_summary',
        text: '先干 1'
      })
    });

    expect(authorized.json()).toMatchObject({
      status: 'reply_decision',
      decision: {
        kind: 'authorize_low_risk',
        todoId: 'todo_http_1',
        todo: { capability: 'content_draft', risk: 'low' }
      }
    });
    expect(wrongChat.json()).toEqual({
      status: 'reply_decision',
      decision: { kind: 'reject', reason: 'wrong_chat' }
    });
    expect(nonIvy.json()).toEqual({
      status: 'reply_decision',
      decision: { kind: 'reject', reason: 'not_ivy' }
    });
    await harness.close();
  });

  it('returns a fixed safe error when reply routing throws', async () => {
    const secretPath = '/credentials/tenant/secret.json';
    const chunks: string[] = [];
    const harness = createHarness({
      logger: {
        level: 'info',
        stream: { write: (message: string) => chunks.push(message) }
      },
      routeReply: () => {
        throw new Error(`reply database failed at ${secretPath}`);
      }
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: privateChatId,
        replyTo: 'om_http_summary',
        text: '先干 1'
      })
    });
    await harness.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'reply_routing_failed' });
    expect(response.body).not.toContain(secretPath);
    expect(chunks.join('')).not.toContain(secretPath);
  });

  it('rejects malformed event envelopes without side effects', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: {
        schema: '2.0',
        header: { token: verificationToken, event_type: 'minutes.minute.generated_v1' },
        event: {}
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_event_envelope' });
    expect(harness.jobRepository.list()).toHaveLength(0);
    await harness.close();
  });

  it('recursively redacts credentials, transcript text, and raw bodies from logs', async () => {
    const chunks: string[] = [];
    const stream = {
      write(message: string) {
        chunks.push(message);
      }
    };
    const harness = createHarness({ logger: { level: 'info', stream } });
    harness.app.log.info({
      first: {
        second: {
          accessToken: 'logged-token-secret',
          appSecret: 'logged-app-secret',
          encryptKey: 'logged-encrypt-key',
          transcriptText: 'logged-transcript-text',
          body: { event: 'logged-raw-event-body' },
          headers: { authorization: 'Bearer logged-authorization' }
        }
      }
    }, 'redaction probe');

    await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events?access_token=request-query-secret',
      headers: { authorization: 'Bearer request-authorization-secret' },
      payload: {
        type: 'url_verification',
        token: verificationToken,
        challenge: 'request-body-secret'
      }
    });
    await harness.close();

    const logs = chunks.join('');
    expect(logs).not.toContain('logged-token-secret');
    expect(logs).not.toContain('logged-app-secret');
    expect(logs).not.toContain('logged-encrypt-key');
    expect(logs).not.toContain('logged-transcript-text');
    expect(logs).not.toContain('logged-raw-event-body');
    expect(logs).not.toContain('logged-authorization');
    expect(logs).not.toContain('request-authorization-secret');
    expect(logs).not.toContain('request-body-secret');
    expect(logs).not.toContain('request-query-secret');
  });
});

function createHarness(
  options: Partial<Pick<AppDependencies, 'logger' | 'routeReply'>> = {}
) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const meetingRepository = new MeetingRepository(database.client);
  const jobRepository = new JobRepository(database.client);
  let workerCalls = 0;
  const app = buildApp({
    readiness: () => ({ ready: true }),
    verificationToken,
    ingestMinute: (event) => ingestMinuteGenerated(event, {
      meetingRepository,
      jobRepository
    }),
    routeReply: options.routeReply ?? ((input) => routeReply(input, {
      meetingRepository,
      ivyPrivateChatId: privateChatId,
      approverOpenIds: ['ou_ivy_fixture']
    })),
    logger: options.logger ?? false
  });

  return {
    app,
    jobRepository,
    meetingRepository,
    get workerCalls() {
      return workerCalls;
    },
    callWorker() {
      workerCalls += 1;
    },
    async close() {
      await app.close();
      database.close();
    }
  };
}

function seedDeliveredTodo(meetingRepository: MeetingRepository): void {
  meetingRepository.ingestMinute({ minuteId: 'min_http', eventId: 'evt_http_minute' });
  meetingRepository.saveSummary({
    id: 'summary_http',
    minuteId: 'min_http',
    summaryMessageId: 'pending:minute-summary:min_http',
    content: 'HTTP 授权测试',
    todos: [{
      id: 'todo_http_1',
      displayedNumber: 1,
      title: '起草会议行动清单',
      description: '只生成内容草稿',
      risk: 'low',
      capability: 'content_draft',
      status: 'proposed'
    }]
  });
  const outboxRepository = new OutboxRepository(meetingRepository.client);
  outboxRepository.enqueueMeetingSummary({
    kind: 'ivy_meeting_summary',
    minuteId: 'min_http',
    summaryId: 'summary_http',
    targetChatId: privateChatId,
    meeting: {
      title: 'HTTP 路由授权测试',
      startedAt: '2030-07-18T05:00:00.000Z',
      endedAt: '2030-07-18T05:30:00.000Z'
    },
    body: 'HTTP 路由授权测试 fixture',
    coreInsights: ['HTTP 路由只能返回授权 decision'],
    confirmedDecisions: ['不执行 Todo'],
    risks: ['身份或回复上下文不匹配必须拒绝'],
    todos: [{
      title: '起草会议行动清单',
      description: '只生成内容草稿',
      risk: 'low',
      capability: 'content_draft'
    }]
  });
  outboxRepository.acknowledgeMeetingSummaryDelivery({
    minuteId: 'min_http',
    messageId: 'om_http_summary',
    deliveredAt: new Date('2030-07-18T05:00:00.000Z')
  });
}

function withEventToken(
  event: Record<string, unknown>,
  token: string
): Record<string, unknown> {
  const header = event.header as Record<string, unknown>;
  return { ...event, header: { ...header, token } };
}

function replyEvent(input: {
  openId: string;
  chatId: string;
  replyTo: string | null;
  text: string;
}) {
  return {
    schema: '2.0',
    header: {
      token: verificationToken,
      event_id: 'evt_reply_1',
      event_type: 'im.message.receive_v1',
      create_time: '2026-07-18T00:00:00.000Z'
    },
    event: {
      sender: { sender_id: { open_id: input.openId } },
      message: {
        chat_id: input.chatId,
        parent_id: input.replyTo,
        message_type: 'text',
        content: JSON.stringify({ text: input.text })
      }
    }
  };
}
