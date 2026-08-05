import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { deliverPendingContextReviews, FeishuMessageDeliveryAdapter } from '../src/adapters/feishu.js';

describe('Context review outbox', () => {
  it('enqueues once and binds the real Feishu message ID without touching meeting summaries', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new OutboxRepository(database.client);
    const message = { kind: 'ivy_context_review' as const, extractionRunId: 'run1', targetChatId: 'oc_ivy',
      card: { schema: '2.0' }, cardNonce: 'nonce-1', expiresAt: '2030-01-02T00:00:00.000Z',
      candidateIds: [], promotionIntents: [] };
    expect(repository.enqueueContextReview(message).created).toBe(true);
    expect(repository.enqueueContextReview(message).created).toBe(false);
    expect(repository.listPendingContextReviews()).toEqual([message]);
    expect(repository.acknowledgeContextReviewDelivery({ extractionRunId: 'run1', messageId: 'om_real',
      deliveredAt: new Date('2030-01-01T00:00:00.000Z') })).toEqual({ updated: true });
    expect(database.client.prepare(`SELECT status, delivered_message_id FROM outbox WHERE idempotency_key = 'context-review:run1'`).get())
      .toEqual({ status: 'delivered', delivered_message_id: 'om_real' });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM meeting_summaries').get()).toEqual({ count: 0 });
  });

  it('delivers the interactive card and acknowledges its real message ID', async () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new OutboxRepository(database.client);
    repository.enqueueContextReview({ kind: 'ivy_context_review', extractionRunId: 'run2',
      targetChatId: 'oc_ivy', card: { schema: '2.0' }, cardNonce: 'nonce-2',
      expiresAt: '2030-01-02T00:00:00.000Z', candidateIds: [], promotionIntents: [] });
    const delivery = new FeishuMessageDeliveryAdapter({
      async getMinuteBasicInfo() { return {}; }, async exportMinuteTranscript() { return []; },
      async sendTextMessage() { return { messageId: 'om_text' }; },
      async sendInteractiveMessage(input) {
        expect(input).toEqual({ chatId: 'oc_ivy', card: { schema: '2.0' } });
        return { messageId: 'om_card' };
      }
    });
    expect(await deliverPendingContextReviews({ outboxRepository: repository, delivery,
      now: () => new Date('2030-01-01T00:00:00.000Z') })).toEqual({ delivered: 1, retried: 0 });
    expect(repository.findDeliveredContextReview('om_card')?.extractionRunId).toBe('run2');
  });

  it('retries on an independent later tick without a new Context job and survives repository restart', async () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    let repository = new OutboxRepository(database.client);
    repository.enqueueContextReview({ kind: 'ivy_context_review', extractionRunId: 'run-retry',
      targetChatId: 'oc_ivy', card: { schema: '2.0' }, cardNonce: 'nonce-retry',
      expiresAt: '2030-01-02T00:00:00.000Z', candidateIds: [], promotionIntents: [] });
    let sends = 0;
    const delivery = new FeishuMessageDeliveryAdapter({
      async getMinuteBasicInfo() { return {}; }, async exportMinuteTranscript() { return []; },
      async sendTextMessage() { return { messageId: 'unused' }; },
      async sendInteractiveMessage() {
        sends += 1;
        if (sends === 1) throw new Error('fixture send failure');
        return { messageId: 'om_retry_success' };
      }
    });
    const firstAt = new Date('2030-01-01T00:00:00.000Z');
    expect(await deliverPendingContextReviews({ outboxRepository: repository, delivery, now: () => firstAt }))
      .toEqual({ delivered: 0, retried: 1 });
    expect(await deliverPendingContextReviews({ outboxRepository: repository, delivery, now: () => firstAt }))
      .toEqual({ delivered: 0, retried: 0 });
    repository = new OutboxRepository(database.client);
    expect(await deliverPendingContextReviews({ outboxRepository: repository, delivery,
      now: () => new Date('2030-01-01T00:00:01.001Z') })).toEqual({ delivered: 1, retried: 0 });
    expect(sends).toBe(2);
    expect(repository.findDeliveredContextReview('om_retry_success')?.extractionRunId).toBe('run-retry');
    expect(database.client.prepare(`SELECT attempt_count, last_error_code, delivered_message_id FROM outbox
      WHERE idempotency_key = 'context-review:run-retry'`).get()).toEqual({
      attempt_count: 1, last_error_code: null, delivered_message_id: 'om_retry_success'
    });
  });

  it('rotates an expired nonce before sending the pending card', async () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new OutboxRepository(database.client);
    repository.enqueueContextReview({ kind: 'ivy_context_review', extractionRunId: 'run-expired',
      targetChatId: 'oc_ivy', cardNonce: 'old-nonce', expiresAt: '2029-12-31T00:00:00.000Z',
      candidateIds: [], promotionIntents: [], card: { body: { elements: [{ value: { cardNonce: 'old-nonce' } }] } } });
    let sentCard: Record<string, unknown> | null = null;
    const delivery = new FeishuMessageDeliveryAdapter({
      async getMinuteBasicInfo() { return {}; }, async exportMinuteTranscript() { return []; },
      async sendTextMessage() { return { messageId: 'unused' }; },
      async sendInteractiveMessage(input) { sentCard = input.card; return { messageId: 'om_fresh_nonce' }; }
    });
    expect(await deliverPendingContextReviews({ outboxRepository: repository, delivery,
      now: () => new Date('2030-01-01T00:00:00.000Z'), nonceFactory: () => 'fresh-nonce' }))
      .toEqual({ delivered: 1, retried: 0 });
    expect(JSON.stringify(sentCard)).not.toContain('old-nonce');
    expect(JSON.stringify(sentCard)).toContain('fresh-nonce');
    expect(repository.findDeliveredContextReview('om_fresh_nonce')).toMatchObject({ cardNonce: 'fresh-nonce' });
  });
});
