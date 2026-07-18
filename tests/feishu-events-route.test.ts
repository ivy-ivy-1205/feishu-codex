import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp, type AppDependencies } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
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

  it('redacts credentials, transcript text, and raw bodies from structured logs', async () => {
    const chunks: string[] = [];
    const stream = {
      write(message: string) {
        chunks.push(message);
      }
    };
    const harness = createHarness({ logger: { level: 'info', stream } });
    harness.app.log.info({
      token: 'logged-token-secret',
      appSecret: 'logged-app-secret',
      encryptKey: 'logged-encrypt-key',
      transcriptText: 'logged-transcript-text',
      body: { event: 'logged-raw-event-body' },
      req: { headers: { authorization: 'Bearer logged-authorization' } }
    }, 'redaction probe');

    await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
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
  });
});

function createHarness(options: Pick<AppDependencies, 'logger'> = {}) {
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
    routeReply: (input) => routeReply(input, {
      meetingRepository,
      ivyPrivateChatId: privateChatId,
      approverOpenIds: ['ou_ivy_fixture']
    }),
    logger: options.logger ?? false
  });

  return {
    app,
    jobRepository,
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
