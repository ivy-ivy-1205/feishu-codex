import type Database from 'better-sqlite3';
import type { MeetingSummaryDraft } from '../ports/summarizer.js';

export interface IvyMeetingSummaryMessage extends MeetingSummaryDraft {
  kind: 'ivy_meeting_summary';
  minuteId: string;
  summaryId: string;
  targetChatId: string;
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

  list(): IvyMeetingSummaryMessage[] {
    const rows = this.client.prepare(`
      SELECT payload FROM outbox ORDER BY created_at ASC
    `).all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as IvyMeetingSummaryMessage);
  }
}
