import type Database from 'better-sqlite3';
import type { MinuteContext } from '../ports/feishu.js';
import type { MeetingSummaryDraft } from '../ports/summarizer.js';

export interface IvyMeetingSummaryMessage extends MeetingSummaryDraft {
  kind: 'ivy_meeting_summary';
  minuteId: string;
  summaryId: string;
  targetChatId: string;
  meeting: Pick<MinuteContext, 'title' | 'startedAt' | 'endedAt'>;
  body: string;
}

export interface MeetingSummaryDeliveryAcknowledgement {
  minuteId: string;
  messageId: string;
  deliveredAt: Date;
}

export class OutboxRepository {
  constructor(readonly client: Database.Database) {}

  enqueueMeetingSummary(message: IvyMeetingSummaryMessage): { created: boolean } {
    const idempotencyKey = `minute-summary:${message.minuteId}`;
    const result = this.client.prepare(`
      INSERT INTO outbox (id, destination, payload, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      idempotencyKey,
      message.targetChatId,
      JSON.stringify(message),
      idempotencyKey,
      new Date().toISOString()
    );

    return { created: result.changes === 1 };
  }

  acknowledgeMeetingSummaryDelivery(
    input: MeetingSummaryDeliveryAcknowledgement
  ): { updated: boolean } {
    const minuteId = input.minuteId.trim();
    const messageId = input.messageId.trim();
    if (!minuteId || !messageId || messageId.startsWith('pending:')) {
      throw new Error('delivery acknowledgement requires an actual message ID');
    }
    const deliveredAt = input.deliveredAt.toISOString();

    return this.client.transaction(() => {
      const idempotencyKey = `minute-summary:${minuteId}`;
      const outboxRow = this.client.prepare(`
        SELECT status, payload
        FROM outbox
        WHERE idempotency_key = ?
      `).get(idempotencyKey) as DeliveryOutboxRow | undefined;
      if (!outboxRow) {
        throw new Error('meeting summary outbox message not found');
      }

      const message = JSON.parse(outboxRow.payload) as IvyMeetingSummaryMessage;
      const summary = this.client.prepare(`
        SELECT id, summary_message_id
        FROM meeting_summaries
        WHERE minute_id = ?
      `).get(minuteId) as DeliverySummaryRow | undefined;
      if (!summary || message.kind !== 'ivy_meeting_summary' || message.summaryId !== summary.id) {
        throw new Error('meeting summary outbox correlation mismatch');
      }

      if (outboxRow.status === 'delivered') {
        if (summary.summary_message_id === messageId) {
          return { updated: false };
        }
        throw new Error('delivery already acknowledged with a different message ID');
      }
      if (outboxRow.status !== 'pending') {
        throw new Error(`cannot acknowledge outbox message in status ${outboxRow.status}`);
      }

      const pendingMessageId = `pending:minute-summary:${minuteId}`;
      if (
        summary.summary_message_id !== pendingMessageId &&
        summary.summary_message_id !== messageId
      ) {
        throw new Error('summary already uses a different message ID');
      }

      const summaryUpdate = this.client.prepare(`
        UPDATE meeting_summaries
        SET summary_message_id = ?
        WHERE id = ? AND summary_message_id = ?
      `).run(messageId, summary.id, summary.summary_message_id);
      const outboxUpdate = this.client.prepare(`
        UPDATE outbox
        SET status = 'delivered', delivered_at = ?
        WHERE idempotency_key = ? AND status = 'pending'
      `).run(deliveredAt, idempotencyKey);
      if (summaryUpdate.changes !== 1 || outboxUpdate.changes !== 1) {
        throw new Error('delivery acknowledgement lost its transaction race');
      }
      return { updated: true };
    })();
  }

  list(): IvyMeetingSummaryMessage[] {
    const rows = this.client.prepare(`
      SELECT payload FROM outbox ORDER BY created_at ASC
    `).all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as IvyMeetingSummaryMessage);
  }

  listPendingMeetingSummaries(): IvyMeetingSummaryMessage[] {
    const rows = this.client.prepare(`
      SELECT payload
      FROM outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `).all() as Array<{ payload: string }>;
    return rows
      .map((row) => JSON.parse(row.payload) as IvyMeetingSummaryMessage)
      .filter((message) => message.kind === 'ivy_meeting_summary');
  }
}

interface DeliveryOutboxRow {
  status: string;
  payload: string;
}

interface DeliverySummaryRow {
  id: string;
  summary_message_id: string;
}
