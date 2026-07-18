import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';

describe('OutboxRepository delivery acknowledgement', () => {
  it('atomically binds the actual message ID so replies resolve to the Todo', () => {
    const harness = createDeliveryHarness();

    expect(harness.outboxRepository.acknowledgeMeetingSummaryDelivery({
      minuteId: 'min_delivery_1',
      messageId: 'om_fixture_summary_1',
      deliveredAt: new Date('2030-07-18T04:00:00.000Z')
    })).toEqual({ updated: true });

    expect(harness.meetingRepository.findTodoByReply('om_fixture_summary_1', 1)?.id)
      .toBe('todo_delivery_1');
    expect(harness.meetingRepository.findTodoByReply(
      'pending:minute-summary:min_delivery_1',
      1
    )).toBeNull();
    expect(readOutboxDelivery(harness.outboxRepository)).toEqual({
      status: 'delivered',
      deliveredAt: '2030-07-18T04:00:00.000Z'
    });
  });

  it('is idempotent for the same acknowledgement and rejects a different message ID', () => {
    const harness = createDeliveryHarness();
    const deliveredAt = new Date('2030-07-18T04:00:00.000Z');
    const acknowledgement = {
      minuteId: 'min_delivery_1',
      messageId: 'om_fixture_summary_1',
      deliveredAt
    };

    expect(harness.outboxRepository.acknowledgeMeetingSummaryDelivery(acknowledgement))
      .toEqual({ updated: true });
    expect(harness.outboxRepository.acknowledgeMeetingSummaryDelivery(acknowledgement))
      .toEqual({ updated: false });
    expect(() => harness.outboxRepository.acknowledgeMeetingSummaryDelivery({
      ...acknowledgement,
      messageId: 'om_fixture_conflicting'
    })).toThrow(/different message ID/);
    expect(harness.meetingRepository.findTodoByReply('om_fixture_summary_1', 1)?.id)
      .toBe('todo_delivery_1');
  });
});

function createDeliveryHarness() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const meetingRepository = new MeetingRepository(database.client);
  const outboxRepository = new OutboxRepository(database.client);
  meetingRepository.ingestMinute({ minuteId: 'min_delivery_1', eventId: 'evt_delivery_1' });
  meetingRepository.saveSummary({
    id: 'summary_delivery_1',
    minuteId: 'min_delivery_1',
    summaryMessageId: 'pending:minute-summary:min_delivery_1',
    content: JSON.stringify({ coreInsights: ['测试 delivery ack'] }),
    todos: [{
      id: 'todo_delivery_1',
      displayedNumber: 1,
      title: '确认 reply lookup',
      description: '使用真实消息 ID 恢复 Todo',
      risk: 'low',
      status: 'proposed'
    }]
  });
  outboxRepository.enqueueMeetingSummary({
    kind: 'ivy_meeting_summary',
    minuteId: 'min_delivery_1',
    summaryId: 'summary_delivery_1',
    targetChatId: 'oc_fixture_ivy',
    coreInsights: ['测试 delivery ack'],
    confirmedDecisions: ['保存真实消息 ID'],
    risks: ['重复回调'],
    todos: [{
      title: '确认 reply lookup',
      description: '使用真实消息 ID 恢复 Todo',
      risk: 'low'
    }]
  });

  return { meetingRepository, outboxRepository };
}

function readOutboxDelivery(outboxRepository: OutboxRepository) {
  const row = outboxRepository.client.prepare(`
    SELECT status, delivered_at
    FROM outbox
    WHERE idempotency_key = 'minute-summary:min_delivery_1'
  `).get() as { status: string; delivered_at: string | null };
  return { status: row.status, deliveredAt: row.delivered_at };
}
