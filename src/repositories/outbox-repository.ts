import type Database from 'better-sqlite3';
import type { MinuteContext } from '../ports/feishu.js';
import type { MeetingSummaryDraft } from '../ports/summarizer.js';
import type { FounderWorkMapCard } from '../services/founder-work-map-renderer.js';
import { canonicalJson } from '../services/canonical-json.js';

export interface FounderWorkMapMessage extends FounderWorkMapCard {
  mapId: string;
  targetChatId: string;
}

export interface IvyMeetingSummaryMessage extends MeetingSummaryDraft {
  kind: 'ivy_meeting_summary';
  minuteId: string;
  summaryId: string;
  targetChatId: string;
  meeting: Pick<MinuteContext, 'title' | 'startedAt' | 'endedAt'>;
  body: string;
}

export interface IvyContextReviewMessage {
  kind: 'ivy_context_review';
  extractionRunId: string;
  targetChatId: string;
  card: Record<string, unknown>;
  cardNonce: string;
  expiresAt: string;
  candidateIds: string[];
  promotionIntents: ContextPromotionIntent[];
}

export interface ContextPromotionIntent {
  id: string;
  candidateId: string;
  targetRecordId: string;
  relationType: 'supplements' | 'confirms' | 'corrects' | 'supersedes' | 'conflicts_with' | 'duplicates';
}

export interface AlignmentQuestionMessage {
  kind: 'alignment_question';
  issueId: string;
  evidenceSetHash: string;
  targetChatId: string;
  card: Record<string, unknown>;
}

export type OutboxMessage = IvyMeetingSummaryMessage | IvyContextReviewMessage | AlignmentQuestionMessage | FounderWorkMapMessage;

export interface MeetingSummaryDeliveryAcknowledgement {
  minuteId: string;
  messageId: string;
  deliveredAt: Date;
}

export class OutboxRepository {
  constructor(readonly client: Database.Database) {}

  enqueueFounderWorkMap(message: FounderWorkMapMessage, now = new Date()): { created: boolean } {
    if (parseOutboxMessage(JSON.stringify(message))?.kind !== 'founder_work_map') throw new Error('invalid founder work map');
    const key = founderWorkMapKey(message);
    const result = this.client.prepare(`INSERT INTO outbox
      (id, destination, payload, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(key, message.targetChatId, JSON.stringify(message), key, now.toISOString());
    if (result.changes === 0) {
      const existing = this.client.prepare('SELECT payload FROM outbox WHERE idempotency_key = ?').get(key) as { payload: string };
      if (canonicalJson(JSON.parse(existing.payload)) !== canonicalJson(message)) throw new Error('founder work map content conflict');
    }
    return { created: result.changes === 1 };
  }

  acknowledgeFounderWorkMapDelivery(input: { mapId: string; page: number; messageId: string; deliveredAt: Date }): { updated: boolean } {
    const messageId = input.messageId.trim();
    if (!messageId || messageId.startsWith('pending:')) throw new Error('delivery acknowledgement requires an actual message ID');
    return this.client.transaction(() => {
      const key = founderWorkMapKey(input);
      const row = this.client.prepare('SELECT payload, status, delivered_message_id FROM outbox WHERE idempotency_key = ?')
        .get(key) as { payload: string; status: string; delivered_message_id: string | null } | undefined;
      const message = row ? parseOutboxMessage(row.payload) : null;
      if (!row || message?.kind !== 'founder_work_map' || message.mapId !== input.mapId || message.page !== input.page) {
        throw new Error('founder work map delivery correlation mismatch');
      }
      if (row.status === 'delivered' && row.delivered_message_id === messageId) return { updated: false };
      if (row.status !== 'pending') throw new Error('founder work map delivery conflict');
      const update = this.client.prepare(`UPDATE outbox SET status = 'delivered', delivered_at = ?, delivered_message_id = ?
        WHERE idempotency_key = ? AND status = 'pending'`).run(input.deliveredAt.toISOString(), messageId, key);
      if (update.changes !== 1) throw new Error('founder work map delivery conflict');
      return { updated: true };
    }).immediate();
  }

  /** The pending batch draft a delivered feedback message asked the founder to confirm, if that message is one. */
  findDeliveredFeedbackDraftId(chatId: string, messageId: string): string | null {
    const row = this.client.prepare(`SELECT payload FROM outbox WHERE destination = ? AND delivered_message_id = ?
      AND status = 'delivered' AND delivered_at IS NOT NULL`).get(chatId, messageId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const message = JSON.parse(row.payload) as { kind?: unknown; targetChatId?: unknown; text?: unknown };
      if (message.kind !== 'founder_feedback' || message.targetChatId !== chatId || typeof message.text !== 'string') return null;
      const ids = [...new Set(message.text.match(/feedbackdraft_[a-f0-9]{32}/gu) ?? [])];
      return ids.length === 1 ? ids[0]! : null;
    } catch { return null; }
  }

  findDeliveredFounderMessage(chatId: string, messageId: string): FounderWorkMapMessage | AlignmentQuestionMessage | null {
    const row = this.client.prepare(`SELECT payload FROM outbox WHERE destination = ? AND delivered_message_id = ?
      AND status = 'delivered' AND delivered_at IS NOT NULL`).get(chatId, messageId) as { payload: string } | undefined;
    const message = row ? parseOutboxMessage(row.payload) : null;
    if (message?.targetChatId !== chatId || (message.kind !== 'founder_work_map' && message.kind !== 'alignment_question')) return null;
    if (message.kind === 'alignment_question') return message;
    const pages = (this.client.prepare(`SELECT payload FROM outbox WHERE destination = ? AND status = 'delivered'
      AND delivered_at IS NOT NULL ORDER BY created_at, id`).all(chatId) as { payload: string }[])
      .map((item) => parseOutboxMessage(item.payload))
      .filter((item): item is FounderWorkMapMessage => item?.kind === 'founder_work_map' && item.mapId === message.mapId);
    const itemRefs = pages.flatMap((page) => page.itemRefs).sort((a, b) => a.displayedNumber - b.displayedNumber);
    if (new Set(itemRefs.map((item) => item.displayedNumber)).size !== itemRefs.length) return null;
    return { ...message, itemRefs };
  }

  enqueueAlignmentQuestion(message: AlignmentQuestionMessage, now = new Date()): { created: boolean } {
    const issue = this.client.prepare("SELECT status, evidence_set_hash FROM alignment_issues WHERE id = ?")
      .get(message.issueId) as { status: string; evidence_set_hash: string } | undefined;
    if (issue?.status !== 'ready' || issue.evidence_set_hash !== message.evidenceSetHash || !message.targetChatId.trim()) {
      throw new Error('alignment question requires a policy-approved ready issue');
    }
    const key = alignmentQuestionKey(message);
    const result = this.client.prepare(`INSERT INTO outbox
      (id, destination, payload, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(key, message.targetChatId, JSON.stringify(message), key, now.toISOString());
    return { created: result.changes === 1 };
  }

  listPendingAlignmentQuestions(availableAt = new Date()): AlignmentQuestionMessage[] {
    const rows = this.client.prepare(`SELECT o.payload FROM outbox o
      JOIN alignment_issues i ON o.idempotency_key = 'alignment-question:' || i.id || ':' || i.evidence_set_hash
      WHERE o.status = 'pending' AND i.status = 'ready' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
      ORDER BY o.created_at, o.id`).all(availableAt.toISOString()) as { payload: string }[];
    return rows.map((row) => parseOutboxMessage(row.payload)).filter((item): item is AlignmentQuestionMessage => item?.kind === 'alignment_question');
  }

  markAlignmentQuestionRetry(input: { issueId: string; evidenceSetHash: string; errorCode: string; retryAt: Date }): void {
    const result = this.client.prepare(`UPDATE outbox SET attempt_count = attempt_count + 1,
      next_attempt_at = ?, last_error_code = ? WHERE idempotency_key = ? AND status = 'pending'`)
      .run(input.retryAt.toISOString(), input.errorCode, alignmentQuestionKey(input));
    if (result.changes !== 1) throw new Error('alignment question retry lost its race');
  }

  acknowledgeAlignmentQuestionDelivery(input: { issueId: string; evidenceSetHash: string; messageId: string; deliveredAt: Date }): { updated: boolean } {
    const messageId = input.messageId.trim();
    if (!messageId || messageId.startsWith('pending:')) throw new Error('delivery acknowledgement requires an actual message ID');
    return this.client.transaction(() => {
      const key = alignmentQuestionKey(input);
      const row = this.client.prepare('SELECT status, payload, delivered_message_id FROM outbox WHERE idempotency_key = ?')
        .get(key) as { status: string; payload: string; delivered_message_id: string | null } | undefined;
      const message = row ? parseOutboxMessage(row.payload) : null;
      const issue = this.client.prepare('SELECT status, evidence_set_hash, delivered_message_id FROM alignment_issues WHERE id = ?')
        .get(input.issueId) as { status: string; evidence_set_hash: string; delivered_message_id: string | null } | undefined;
      if (!row || !issue || message?.kind !== 'alignment_question' || message.issueId !== input.issueId ||
        message.evidenceSetHash !== input.evidenceSetHash || issue.evidence_set_hash !== input.evidenceSetHash) {
        throw new Error('alignment delivery correlation mismatch');
      }
      if (row.status === 'delivered') {
        if (row.delivered_message_id === messageId && issue.delivered_message_id === messageId) return { updated: false };
        throw new Error('delivery already acknowledged with a different message ID');
      }
      if (row.status !== 'pending' || issue.status !== 'ready') throw new Error('alignment issue is not ready');
      const issueUpdate = this.client.prepare("UPDATE alignment_issues SET status = 'asked', delivered_message_id = ?, updated_at = ? WHERE id = ? AND status = 'ready'")
        .run(messageId, input.deliveredAt.toISOString(), input.issueId);
      const outboxUpdate = this.client.prepare(`UPDATE outbox SET status = 'delivered', delivered_at = ?,
        delivered_message_id = ?, next_attempt_at = NULL, last_error_code = NULL
        WHERE idempotency_key = ? AND status = 'pending'`).run(input.deliveredAt.toISOString(), messageId, key);
      if (issueUpdate.changes !== 1 || outboxUpdate.changes !== 1) throw new Error('alignment delivery lost its race');
      return { updated: true };
    }).immediate();
  }

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

  enqueueContextReview(message: IvyContextReviewMessage): { created: boolean } {
    const idempotencyKey = `context-review:${message.extractionRunId}`;
    const result = this.client.prepare(`
      INSERT INTO outbox (id, destination, payload, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(idempotencyKey, message.targetChatId, JSON.stringify(message), idempotencyKey,
      new Date().toISOString());
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
        SET status = 'delivered', delivered_at = ?, delivered_message_id = ?
        WHERE idempotency_key = ? AND status = 'pending'
      `).run(deliveredAt, messageId, idempotencyKey);
      if (summaryUpdate.changes !== 1 || outboxUpdate.changes !== 1) {
        throw new Error('delivery acknowledgement lost its transaction race');
      }
      return { updated: true };
    })();
  }

  acknowledgeContextReviewDelivery(input: {
    extractionRunId: string;
    messageId: string;
    deliveredAt: Date;
  }): { updated: boolean } {
    const messageId = input.messageId.trim();
    if (!messageId || messageId.startsWith('pending:')) throw new Error('delivery acknowledgement requires an actual message ID');
    const key = `context-review:${input.extractionRunId}`;
    const row = this.client.prepare('SELECT status, delivered_message_id, payload FROM outbox WHERE idempotency_key = ?')
      .get(key) as { status: string; delivered_message_id: string | null; payload: string } | undefined;
    if (!row || parseOutboxMessage(row.payload)?.kind !== 'ivy_context_review') throw new Error('context review outbox message not found');
    if (row.status === 'delivered') {
      if (row.delivered_message_id === messageId) return { updated: false };
      throw new Error('delivery already acknowledged with a different message ID');
    }
    const result = this.client.prepare(`
      UPDATE outbox SET status = 'delivered', delivered_at = ?, delivered_message_id = ?,
        next_attempt_at = NULL, last_error_code = NULL
      WHERE idempotency_key = ? AND status = 'pending'
    `).run(input.deliveredAt.toISOString(), messageId, key);
    if (result.changes !== 1) throw new Error('context review acknowledgement lost its race');
    return { updated: true };
  }

  list(): IvyMeetingSummaryMessage[] {
    return this.listAll().filter((message): message is IvyMeetingSummaryMessage =>
      message.kind === 'ivy_meeting_summary');
  }

  listAll(): OutboxMessage[] {
    const rows = this.client.prepare(`
      SELECT payload FROM outbox ORDER BY created_at ASC
    `).all() as Array<{ payload: string }>;
    return rows.map((row) => parseOutboxMessage(row.payload))
      .filter((message): message is OutboxMessage => message !== null);
  }

  listPendingMeetingSummaries(): IvyMeetingSummaryMessage[] {
    const rows = this.client.prepare(`
      SELECT payload
      FROM outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `).all() as Array<{ payload: string }>;
    return rows.map((row) => parseOutboxMessage(row.payload))
      .filter((message): message is IvyMeetingSummaryMessage => message?.kind === 'ivy_meeting_summary');
  }

  listPendingContextReviews(availableAt = new Date()): IvyContextReviewMessage[] {
    return this.listPendingContextReviewDeliveries(availableAt).map((item) => item.message);
  }

  listPendingContextReviewDeliveries(availableAt: Date): Array<{
    message: IvyContextReviewMessage;
    attemptCount: number;
  }> {
    const rows = this.client.prepare(`SELECT payload, attempt_count FROM outbox
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC`).all(availableAt.toISOString()) as Array<{ payload: string; attempt_count: number }>;
    return rows.map((row) => ({ message: parseOutboxMessage(row.payload), attemptCount: row.attempt_count }))
      .filter((item): item is { message: IvyContextReviewMessage; attemptCount: number } =>
        item.message?.kind === 'ivy_context_review');
  }

  markContextReviewRetry(input: { extractionRunId: string; errorCode: string; retryAt: Date }): void {
    const result = this.client.prepare(`UPDATE outbox SET attempt_count = attempt_count + 1,
      next_attempt_at = ?, last_error_code = ? WHERE idempotency_key = ? AND status = 'pending'`)
      .run(input.retryAt.toISOString(), input.errorCode, `context-review:${input.extractionRunId}`);
    if (result.changes !== 1) throw new Error('context review retry lost its race');
  }

  refreshExpiredContextReview(input: { extractionRunId: string; cardNonce: string; expiresAt: Date }): IvyContextReviewMessage {
    return this.client.transaction(() => {
      const key = `context-review:${input.extractionRunId}`;
      const row = this.client.prepare(`SELECT payload FROM outbox WHERE idempotency_key = ? AND status = 'pending'`)
        .get(key) as { payload: string } | undefined;
      const message = row ? parseOutboxMessage(row.payload) : null;
      if (message?.kind !== 'ivy_context_review') throw new Error('pending context review not found');
      const refreshed: IvyContextReviewMessage = { ...message, cardNonce: input.cardNonce,
        expiresAt: input.expiresAt.toISOString(),
        card: replaceCardNonce(message.card, input.cardNonce) as Record<string, unknown> };
      const result = this.client.prepare(`UPDATE outbox SET payload = ? WHERE idempotency_key = ? AND status = 'pending'`)
        .run(JSON.stringify(refreshed), key);
      if (result.changes !== 1) throw new Error('context review refresh lost its race');
      return refreshed;
    })();
  }

  findDeliveredContextReview(messageId: string): IvyContextReviewMessage | null {
    const row = this.client.prepare(`
      SELECT payload FROM outbox WHERE status = 'delivered' AND delivered_message_id = ?
    `).get(messageId) as { payload: string } | undefined;
    const message = row ? parseOutboxMessage(row.payload) : null;
    return message?.kind === 'ivy_context_review' ? message : null;
  }
}

function parseOutboxMessage(payload: string): OutboxMessage | null {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return null; }
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'founder_work_map' && typeof value.mapId === 'string' && value.mapId.trim() &&
    typeof value.targetChatId === 'string' && value.targetChatId.trim() && isRecord(value.card) &&
    Number.isSafeInteger(value.page) && Number(value.page) > 0 && Number.isSafeInteger(value.totalPages) &&
    Number(value.totalPages) >= Number(value.page) && Array.isArray(value.itemRefs) && value.itemRefs.length <= 12 &&
    value.itemRefs.every((ref) => isRecord(ref) && ['topic', 'uncertain_grouping', 'coverage_gap'].includes(String(ref.kind)) &&
      typeof ref.id === 'string' && ref.id.trim() && Number.isSafeInteger(ref.displayedNumber) && Number(ref.displayedNumber) > 0 &&
      (ref.kind !== 'topic' || (Number.isSafeInteger(ref.expectedVersion) && Number(ref.expectedVersion) > 0))) &&
    new Set(value.itemRefs.map((ref) => ref.displayedNumber)).size === value.itemRefs.length) {
    return value as unknown as FounderWorkMapMessage;
  }
  if (value.kind === 'alignment_question' && typeof value.issueId === 'string' &&
    typeof value.evidenceSetHash === 'string' && typeof value.targetChatId === 'string' && isRecord(value.card)) {
    return value as unknown as AlignmentQuestionMessage;
  }
  if (value.kind === 'ivy_meeting_summary' && typeof value.minuteId === 'string' &&
    typeof value.summaryId === 'string' && typeof value.targetChatId === 'string' && typeof value.body === 'string') {
    return value as unknown as IvyMeetingSummaryMessage;
  }
  if (value.kind === 'ivy_context_review' && typeof value.extractionRunId === 'string' &&
    typeof value.targetChatId === 'string' && isRecord(value.card) && typeof value.cardNonce === 'string' &&
    typeof value.expiresAt === 'string' && isStringArray(value.candidateIds) &&
    Array.isArray(value.promotionIntents) && value.promotionIntents.every(isPromotionIntent)) {
    return value as unknown as IvyContextReviewMessage;
  }
  return null;
}

function alignmentQuestionKey(input: { issueId: string; evidenceSetHash: string }): string {
  return `alignment-question:${input.issueId}:${input.evidenceSetHash}`;
}

function founderWorkMapKey(input: { mapId: string; page: number }): string {
  return `founder-work-map:${input.mapId}:${input.page}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPromotionIntent(value: unknown): value is ContextPromotionIntent {
  return isRecord(value) && typeof value.id === 'string' && typeof value.candidateId === 'string' &&
    typeof value.targetRecordId === 'string' && typeof value.relationType === 'string' &&
    ['supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates']
      .includes(value.relationType);
}

function replaceCardNonce(value: unknown, cardNonce: string): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceCardNonce(item, cardNonce));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'cardNonce' ? cardNonce : replaceCardNonce(item, cardNonce)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DeliveryOutboxRow {
  status: string;
  payload: string;
}

interface DeliverySummaryRow {
  id: string;
  summary_message_id: string;
}
