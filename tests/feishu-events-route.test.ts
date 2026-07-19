import { readFileSync } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
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
const encryptKey = 'encrypt-test-key';
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

  it('echoes an encrypted Feishu URL verification challenge', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: encryptFeishuPayload({
        type: 'url_verification',
        token: verificationToken,
        challenge: 'encrypted-challenge-token'
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: 'encrypted-challenge-token' });
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
    expect(harness.jobRepository.list()).toMatchObject([
      { kind: 'process_minute', key: 'minute:min_fixture_1' }
    ]);
    expect(harness.persistedEffects()).toEqual({ summaries: 0, outbox: 0 });
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
    expect(harness.persistedEffects()).toEqual({ summaries: 0, outbox: 0 });
    await harness.close();
  });

  it('accepts direct Feishu text messages with empty reply context fields', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: privateChatId,
        replyTo: '',
        text: '测试 webhook 到达'
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'reply_decision',
      decision: { kind: 'clarify', reason: 'missing_reply_context' }
    });
    await harness.close();
  });

  it('accepts direct Feishu post messages by extracting text leaves', async () => {
    const sentMessages: Array<{ chatId: string; text: string }> = [];
    const harness = createHarness({
      sendTextMessage: async (message) => {
        sentMessages.push(message);
        return { messageId: 'om_direct_ack' };
      }
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: privateChatId,
        replyTo: '',
        text: '测试 webhook 第二次到达'
      }, { messageType: 'post' })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'reply_decision',
      decision: { kind: 'clarify', reason: 'missing_reply_context' },
      acknowledgement: { messageId: 'om_direct_ack' }
    });
    expect(sentMessages).toEqual([{
      chatId: privateChatId,
      text: '我已收到。当前还未绑定会议纪要，请在会议总结下回复 Todo 编号，或等待妙记事件接入。'
    }]);
    await harness.close();
  });

  it('does not send direct acknowledgement for wrong chats', async () => {
    const sentMessages: Array<{ chatId: string; text: string }> = [];
    const harness = createHarness({
      sendTextMessage: async (message) => {
        sentMessages.push(message);
        return { messageId: 'om_must_not_send' };
      }
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: 'oc_wrong_chat',
        replyTo: '',
        text: '测试 webhook'
      }, { messageType: 'post' })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'reply_decision',
      decision: { kind: 'reject', reason: 'wrong_chat' }
    });
    expect(sentMessages).toEqual([]);
    await harness.close();
  });

  it('logs only non-sensitive shape diagnostics for rejected Feishu events', async () => {
    const chunks: string[] = [];
    const harness = createHarness({
      logger: {
        level: 'info',
        stream: { write: (message: string) => chunks.push(message) }
      }
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: replyEvent({
        openId: 'ou_ivy_fixture',
        chatId: privateChatId,
        replyTo: null,
        text: 'sensitive message body must not be logged'
      }, { messageType: 'audio' })
    });
    await harness.close();

    const logs = chunks.join('');
    expect(response.statusCode).toBe(400);
    expect(logs).toContain('Feishu event rejected');
    expect(logs).toContain('invalid_reply_event');
    expect(logs).toContain('im.message.receive_v1');
    expect(logs).toContain('message_type');
    expect(logs).toContain('content');
    expect(logs).not.toContain('sensitive message body must not be logged');
    expect(logs).not.toContain(verificationToken);
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
  options: Partial<Pick<AppDependencies, 'logger' | 'routeReply' | 'sendTextMessage'>> = {}
) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const meetingRepository = new MeetingRepository(database.client);
  const jobRepository = new JobRepository(database.client);
  const app = buildApp({
    readiness: () => ({ ready: true }),
    verificationToken,
    encryptKey,
    ingestMinute: (event) => ingestMinuteGenerated(event, {
      meetingRepository,
      jobRepository
    }),
    routeReply: options.routeReply ?? ((input) => routeReply(input, {
      meetingRepository,
      ivyPrivateChatId: privateChatId,
      approverOpenIds: ['ou_ivy_fixture']
    })),
    sendTextMessage: options.sendTextMessage,
    logger: options.logger ?? false
  });

  return {
    app,
    jobRepository,
    meetingRepository,
    persistedEffects() {
      const summaries = database.client.prepare(
        'SELECT COUNT(*) AS count FROM meeting_summaries'
      ).get() as { count: number };
      const outbox = database.client.prepare(
        'SELECT COUNT(*) AS count FROM outbox'
      ).get() as { count: number };
      return { summaries: summaries.count, outbox: outbox.count };
    },
    async close() {
      await app.close();
      database.close();
    }
  };
}

function encryptFeishuPayload(payload: Record<string, unknown>): { encrypt: string } {
  const iv = randomBytes(16);
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  return { encrypt: Buffer.concat([iv, encrypted]).toString('base64') };
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
}, options: { messageType?: string } = {}) {
  const content = options.messageType === 'post'
    ? JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: input.text }]]
    })
    : JSON.stringify({ text: input.text });
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
        root_id: input.replyTo,
        message_type: options.messageType ?? 'text',
        content
      }
    }
  };
}
