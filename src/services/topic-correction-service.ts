import type Database from 'better-sqlite3';
import { z } from 'zod';
import { topicStageSchema, type CurrentTopic } from '../domain/topic.js';
import { TopicRepository, TopicVersionConflictError } from '../repositories/topic-repository.js';
import { AlignmentRepository } from '../repositories/alignment-repository.js';
import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { captureGroupMessageSource } from './group-message-source-capture.js';
import { PerspectiveReconciler } from './perspective-reconciler.js';
import { canonicalJson, sha256, stableId } from './canonical-json.js';
import type { CurrentPerspective } from '../domain/alignment.js';
import { compareEvidence, evidenceOrder, isStrictlyNewer } from './evidence-order.js';

export const founderFeedbackInputSchema = z.object({
  chatId: z.string().trim().min(1), openId: z.string().regex(/^ou_\S+$/u),
  messageId: z.string().trim().min(1), replyTo: z.string().trim().min(1).nullable(),
  text: z.string().trim().min(1).max(2000), occurredAt: z.iso.datetime(),
  threadId: z.string().trim().min(1).nullable().optional(), rootId: z.string().trim().min(1).nullable().optional()
});
export type FounderFeedbackInput = z.infer<typeof founderFeedbackInputSchema>;
const topicRef = z.object({ id: z.string().min(1), expectedVersion: z.number().int().positive() }).strict();
const issueRef = z.object({ id: z.string().min(1), expectedStatus: z.literal('asked'), expectedUpdatedAt: z.iso.datetime() }).strict();
export const topicCorrectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merge_topics'), topics: z.array(topicRef).min(2).max(12) }).strict(),
  z.object({ kind: z.literal('split_topic'), topic: topicRef, names: z.array(z.string().trim().min(1).max(80)).min(2).max(6) }).strict(),
  z.object({ kind: z.literal('reclassify_stage'), topic: topicRef, stage: topicStageSchema }).strict(),
  z.object({ kind: z.literal('rename_topic'), topic: topicRef, name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('pause_topic'), topic: topicRef }).strict(),
  z.object({ kind: z.literal('dismiss_alignment'), issue: issueRef }).strict(),
  z.object({ kind: z.literal('resolve_alignment'), issue: issueRef, statement: z.string().trim().min(1).max(1000),
    speechAct: z.enum(['decision_proposal', 'explicit_agreement', 'explicit_disagreement']) }).strict()
]);
export type TopicCorrection = z.infer<typeof topicCorrectionSchema>;
export type FounderFeedbackDecision =
  | { kind: 'reject'; reason: 'invalid_input' | 'wrong_chat' | 'unknown_founder' | 'unrelated_message' | 'message_conflict' }
  | { kind: 'clarify'; reason: 'missing_reply_context' | 'ambiguous_feedback' | 'stale_context'; text: string }
  | { kind: 'corrected' | 'duplicate'; correctionKind: TopicCorrection['kind'];
      status: 'applied' | 'awaiting_other_founder' | 'resolved' | 'historical_only' | 'support_withdrawn'; text: string };
export interface FounderFeedbackDependencies { client: Database.Database; approvedChatIds: readonly string[]; now(): Date }

export function findFeedbackReplay(input: FounderFeedbackInput, client: Database.Database): FounderFeedbackDecision | null {
  const row = client.prepare('SELECT input_hash, result_json FROM founder_feedback_corrections WHERE chat_id = ? AND source_message_id = ?')
    .get(input.chatId, input.messageId) as { input_hash: string; result_json: string } | undefined;
  if (!row) return null;
  if (row.input_hash !== feedbackHash(input)) return { kind: 'reject', reason: 'message_conflict' };
  return { ...JSON.parse(row.result_json) as FounderFeedbackDecision, kind: 'duplicate' } as FounderFeedbackDecision;
}

/** Local transaction only: stores evidence and append-only corrections; never executes Todos or sends messages. */
export function applyTopicCorrection(rawInput: FounderFeedbackInput, rawCorrection: TopicCorrection,
  dependencies: FounderFeedbackDependencies): FounderFeedbackDecision {
  const input = founderFeedbackInputSchema.parse(rawInput), correction = topicCorrectionSchema.parse(rawCorrection);
  const { client } = dependencies;
  if (!dependencies.approvedChatIds.includes(input.chatId)) return { kind: 'reject', reason: 'wrong_chat' };
  if (!client.prepare("SELECT id FROM founder_identities WHERE source_system = 'feishu' AND external_author_id = ?").get(input.openId)) {
    return { kind: 'reject', reason: 'unknown_founder' };
  }
  try {
    return client.transaction(() => {
      const replay = findFeedbackReplay(input, client); if (replay) return replay;
      const message = input.replyTo ? new OutboxRepository(client).findDeliveredFounderMessage(input.chatId, input.replyTo) : null;
      if (!message) return { kind: 'reject', reason: 'unrelated_message' } as const;
      const topics = new TopicRepository(client), issues = new AlignmentIssueRepository(client);
      const refs = 'topics' in correction ? correction.topics : 'topic' in correction ? [correction.topic] : [];
      if (new Set(refs.map((ref) => ref.id)).size !== refs.length) throw new TopicVersionConflictError();
      const currentTopics = topics.listCurrentTopics();
      const targets = refs.map((ref) => {
        if (message.kind !== 'founder_work_map' || !message.itemRefs.some((item) => item.kind === 'topic' &&
          item.id === ref.id && item.expectedVersion === ref.expectedVersion)) throw new TopicVersionConflictError();
        const current = currentTopics.find((t) => t.id === ref.id);
        if (!current || current.currentVersion !== ref.expectedVersion) throw new TopicVersionConflictError();
        return current;
      });
      const issue = 'issue' in correction ? issues.get(correction.issue.id) : null;
      if ('issue' in correction && (!issue || message.kind !== 'alignment_question' || message.issueId !== issue.id ||
        message.evidenceSetHash !== issue.evidenceSetHash || issue.deliveredMessageId !== input.replyTo ||
        issue.status !== correction.issue.expectedStatus || issue.updatedAt !== correction.issue.expectedUpdatedAt ||
        Date.parse(input.occurredAt) < Date.parse(issue.updatedAt))) {
        throw new TopicVersionConflictError();
      }
      if (correction.kind === 'split_topic' && new Set(correction.names).size !== correction.names.length) throw new TopicVersionConflictError();
      const now = dependencies.now();
      const captured = captureGroupMessageSource({ chatId: input.chatId, messageId: input.messageId,
        threadId: input.threadId ?? null, rootId: input.rootId ?? null, author: { openId: input.openId, displayName: null },
        messageType: 'text', senderType: 'user', text: input.text, occurredAt: input.occurredAt }, now);
      const sources = new ContextSourceRepository(client), source = sources.saveSource(captured.source).source;
      if (source.authors.length !== 1 || source.authors[0]?.openId !== input.openId || source.occurredAt !== input.occurredAt) {
        return { kind: 'reject', reason: 'message_conflict' } as const;
      }
      const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: input.text,
        locator: { ...captured.messageLocator, threadId: typeof source.metadata.threadId === 'string' ? source.metadata.threadId : null,
          sourceVersion: source.sourceVersion, contentHash: source.contentHash },
        evidenceLevel: 'primary_statement', capturedAt: now }).evidence;
      const append = (t: CurrentTopic, changes: Partial<Pick<CurrentTopic, 'displayName' | 'stage'>> = {}) => topics.appendVersion({
        topicId: t.id, expectedVersion: t.currentVersion, displayName: t.displayName, stage: t.stage, outcome: t.outcome,
        rationale: `群内人工纠正：${correction.kind}`, evidenceIds: [...t.evidenceIds, evidence.id], changedAt: now, ...changes
      });
      let status: 'applied' | 'awaiting_other_founder' | 'resolved' | 'historical_only' | 'support_withdrawn' = 'applied';
      if (correction.kind === 'merge_topics') {
        for (const t of targets) append(t);
        for (const t of targets.slice(1)) topics.addRelation({ fromTopicId: targets[0]!.id, toTopicId: t.id,
          relationType: 'same_as', rationale: '群内明确确认属于同一项目', createdAt: now });
      } else if (correction.kind === 'split_topic') {
        const parent = targets[0]!; append(parent);
        for (const name of correction.names) {
          const child = topics.createTopic({ displayName: name, stage: parent.stage, outcome: null,
            rationale: '群内明确拆分', evidenceIds: [...parent.evidenceIds, evidence.id], createdAt: now });
          topics.addRelation({ fromTopicId: child.id, toTopicId: parent.id, relationType: 'split_from', rationale: '群内明确拆分', createdAt: now });
        }
      } else if (correction.kind === 'rename_topic') append(targets[0]!, { displayName: correction.name });
      else if (correction.kind === 'reclassify_stage') append(targets[0]!, { stage: correction.stage });
      else if (correction.kind === 'pause_topic') append(targets[0]!, { stage: 'paused' });
      else if (issue) {
        let closeStatus: 'resolved' | 'dismissed' | null = correction.kind === 'dismiss_alignment' ? 'dismissed' : null;
        if (correction.kind === 'resolve_alignment') {
          const alignment = new AlignmentRepository(client);
          const founder = alignment.resolveFounderForEvidence(evidence.id)!;
          const current = alignment.getCurrentPerspective(issue.topicId, founder === 'ivy' ? 'ivy_view' : 'james_view');
          const other = alignment.getCurrentPerspective(issue.topicId, founder === 'ivy' ? 'james_view' : 'ivy_view');
          // Source time is authoritative. At equal times retain the first-ingested view;
          // the later arrival is audit-only and conflicting tied support cannot form consensus.
          if (current && !isStrictlyNewer(client,evidence.id,current.evidenceIds)) {
            new PerspectiveReconciler(alignment).reconcile({topicId:issue.topicId,evidenceId:evidence.id,statement:correction.statement,
              speechAct:correction.speechAct,decisionKey:issue.decisionKey,confidence:1,observedAt:new Date(source.occurredAt)});
            status = 'historical_only';
          } else {
            const otherTime = latestPerspectiveSourceTime(client, other);
            const speechAct = correction.speechAct === 'explicit_agreement' &&
              (otherTime === null || otherTime < Date.parse(issue.updatedAt) || other!.evidenceIds.some(id=>{
                const order=compareEvidence(client,evidence.id,id);return order===null||order<0;
              }) ||
                hasAmbiguousTiedSupport(client, other!, issue.id))
              ? 'view' as const : correction.speechAct;
            const reconciler = new PerspectiveReconciler(alignment);
            const result = reconciler.reconcile({ topicId: issue.topicId, evidenceId: evidence.id, statement: correction.statement,
              speechAct, decisionKey: issue.decisionKey, confidence: 1, observedAt: new Date(source.occurredAt) });
            closeStatus = result.versions.some((v) => v.kind === 'shared_decision' && v.evidenceIds.includes(evidence.id)) ? 'resolved' : null;
            status = correction.speechAct === 'explicit_disagreement' ? 'support_withdrawn'
              : closeStatus ? 'resolved' : 'awaiting_other_founder';
          }
        }
        if (closeStatus) {
          const updated = client.prepare('UPDATE alignment_issues SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?')
            .run(closeStatus, now.toISOString(), issue.id, correction.issue.expectedStatus, correction.issue.expectedUpdatedAt);
          if (updated.changes !== 1) throw new TopicVersionConflictError();
        }
      }
      const result: FounderFeedbackDecision = { kind: 'corrected', correctionKind: correction.kind, status,
        text: status === 'historical_only' ? '已保留这条历史回复；当前理解不覆盖。若同一时间有不同表态，需要新的明确确认。' :
          status === 'support_withdrawn' ? '已记录撤回或否定，之前的支持不再作为共识依据；尚未推断新的方案。' :
          status === 'awaiting_other_founder' ? '已记录你的方案，等待另一位明确确认；尚未记为共同决定。' :
          status === 'resolved' ? '已记录双方明确确认，问题已对齐；不会自动执行任务。' :
            correction.kind === 'dismiss_alignment' ? '已停止此项提醒；这不代表双方已达成一致。' : '已记录纠正，并保留原始讨论与历史版本。' };
      client.prepare(`INSERT INTO founder_feedback_corrections
        (id, chat_id, source_message_id, author_open_id, binding_message_id, evidence_id, input_hash, correction_json, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(stableId('feedback', `${input.chatId}\n${input.messageId}`), input.chatId, input.messageId, input.openId, input.replyTo,
          evidence.id, feedbackHash(input), JSON.stringify(correction), JSON.stringify(result), now.toISOString());
      return result;
    }).immediate();
  } catch (error) {
    if (error instanceof TopicVersionConflictError || (error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && error.code.startsWith('SQLITE_BUSY'))) return staleFeedback();
    throw error;
  }
}

export function staleFeedback(): FounderFeedbackDecision {
  return { kind: 'clarify', reason: 'stale_context', text: '这张卡对应的内容已更新，请回复最新卡片再确认。' };
}
function feedbackHash(input: FounderFeedbackInput): string { return sha256(canonicalJson(input)); }

function latestPerspectiveSourceTime(client: Database.Database, perspective: CurrentPerspective | null): number | null {
  if (!perspective || perspective.evidenceIds.length === 0) return null;
  const times = perspective.evidenceIds.map((id) => {
    return evidenceOrder(client,id)?.occurredAt ?? NaN;
  });
  return times.every(Number.isFinite) ? Math.max(...times) : null;
}

function hasAmbiguousTiedSupport(client: Database.Database, perspective: CurrentPerspective, issueId: string): boolean {
  const time = latestPerspectiveSourceTime(client, perspective);
  if (time === null) return true;
  const rows = client.prepare(`SELECT f.correction_json, s.occurred_at, e.id AS evidence_id FROM founder_feedback_corrections f
    JOIN context_evidence e ON e.id = f.evidence_id JOIN context_sources s ON s.id = e.source_id
    JOIN founder_identities i ON i.source_system = s.source_system AND i.external_author_id = f.author_open_id
    WHERE i.founder = ?`).all(perspective.kind === 'ivy_view' ? 'ivy' : 'james') as
    { correction_json: string; occurred_at: string; evidence_id: string }[];
  return rows.some((row) => {
    if (Date.parse(row.occurred_at) !== time || perspective.evidenceIds.includes(row.evidence_id)) return false;
    const parsed = topicCorrectionSchema.safeParse(JSON.parse(row.correction_json));
    return parsed.success && parsed.data.kind === 'resolve_alignment' && parsed.data.issue.id === issueId &&
      (parsed.data.statement !== perspective.statement || parsed.data.speechAct !== perspective.speechAct);
  });
}
