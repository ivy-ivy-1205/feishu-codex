import { describe, expect, it } from 'vitest';
import { routeFounderFeedback } from '../src/services/founder-feedback-router.js';
import { feedbackHarness } from './helpers/founder-feedback-fixtures.js';
import { AlignmentDetector } from '../src/services/alignment-detector.js';
import { AlignmentIssueRepository } from '../src/repositories/alignment-issue-repository.js';
import { AlignmentNotificationPolicy } from '../src/services/alignment-notification-policy.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { feedbackNow, feedbackChat } from './helpers/founder-feedback-fixtures.js';
import { applyTopicCorrection } from '../src/services/topic-correction-service.js';
import { migrateDatabase } from '../src/db/migrate.js';

function alignmentHarness() {
  const h = feedbackHarness(1), sources = new ContextSourceRepository(h.db.client);
  const evidence = (messageId: string, author: string, text: string) => {
    const c = captureGroupMessageSource({ chatId: feedbackChat, messageId, threadId: null, rootId: null,
      author: { openId: author, displayName: null }, messageType: 'text', text, occurredAt: '2026-09-21T09:00:00.000Z' }, feedbackNow);
    const s = sources.saveSource(c.source).source;
    return sources.saveEvidence({ sourceId: s.id, excerpt: text, locator: { ...c.messageLocator, sourceVersion: s.sourceVersion,
      contentHash: s.contentHash }, evidenceLevel: 'primary_statement', capturedAt: feedbackNow }).evidence.id;
  };
  const ivy = evidence('om_original_i', 'ou_ivy', '按 A 方案推进，今天开始实施');
  const james = evidence('om_original_j', 'ou_james', '按 B 方案推进，今天开始实施');
  const candidate = new AlignmentDetector().propose({ topicId: h.created[0]!.id, decisionKey: 'delivery', dimension: 'direction',
    ivy: { evidenceId: ivy, statement: '按 A 方案推进' }, james: { evidenceId: james, statement: '按 B 方案推进' },
    actionConsequence: { evidenceId: ivy, excerpt: '今天开始实施' }, actionHorizon: { evidenceId: ivy, excerpt: '今天',
      startsAt: '2026-09-21T00:00:00.000Z', endsAt: '2026-09-22T00:00:00.000Z' } });
  const issues = new AlignmentIssueRepository(h.db.client);
  const policy = new AlignmentNotificationPolicy(issues, h.alignment, h.outbox);
  policy.prepare(candidate, { targetChatId: feedbackChat, card: {} }, feedbackNow);
  h.outbox.acknowledgeAlignmentQuestionDelivery({ issueId: candidate.id, evidenceSetHash: candidate.evidenceSetHash,
    messageId: 'om_question', deliveredAt: feedbackNow });
  return { ...h, issues, candidate, input: { ...h.input, replyTo: 'om_question', text: '按 A 方案推进' } };
}

describe('immutable founder corrections', () => {
  it('preserves old versions and atomically stores source, author and expected version audit', () => {
    const h = feedbackHarness(1); const original = h.topics.listVersions(h.created[0]!.id);
    const result = routeFounderFeedback({ ...h.input, text: '第 1 项改名为 新名称' }, h.dependencies);
    expect(result.kind).toBe('corrected');
    expect(h.topics.listVersions(h.created[0]!.id)[0]).toEqual(original[0]);
    expect(h.topics.listVersions(h.created[0]!.id)[1]).toMatchObject({ displayName: '新名称', versionNumber: 2 });
    const audit = h.db.client.prepare('SELECT * FROM founder_feedback_corrections').get() as Record<string, string>;
    expect(audit).toMatchObject({ author_open_id: 'ou_ivy', source_message_id: 'om_feedback', binding_message_id: 'om_map' });
    expect(JSON.parse(audit.correction_json!)).toMatchObject({ kind: 'rename_topic', topic: { expectedVersion: 1 } });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_evidence WHERE id = ?').get(audit.evidence_id)).toEqual({ n: 1 });
    h.db.client.close();
  });
  it('replays exactly once and rejects a reused message ID with changed content or actor', () => {
    const h = feedbackHarness(1); const input = { ...h.input, text: '第 1 项改名为 新名称' };
    expect(routeFounderFeedback(input, h.dependencies).kind).toBe('corrected');
    expect(routeFounderFeedback(input, h.dependencies).kind).toBe('duplicate');
    expect(routeFounderFeedback({ ...input, text: '第 1 项改名为 另一个' }, h.dependencies).kind).toBe('reject');
    expect(routeFounderFeedback({ ...input, openId: 'ou_james' }, h.dependencies).kind).toBe('reject');
    expect(h.topics.listVersions(h.created[0]!.id)).toHaveLength(2); h.db.client.close();
  });
  it('keeps committed correction evidence and audit unchanged across repeated migration', () => {
    const h = feedbackHarness(1);
    routeFounderFeedback({ ...h.input, text: '暂停第 1 项' }, h.dependencies);
    const before = h.db.client.prepare('SELECT * FROM founder_feedback_corrections').all();
    migrateDatabase(h.db.client); migrateDatabase(h.db.client);
    expect(h.db.client.prepare('SELECT * FROM founder_feedback_corrections').all()).toEqual(before);
    expect(h.topics.listCurrentTopics()[0]?.stage).toBe('paused'); h.db.client.close();
  });
  it('rolls back the first topic version if the second merge append fails', () => {
    const h = feedbackHarness(); const fourth = h.topicAt(4);
    h.db.client.exec(`CREATE TRIGGER reject_second_merge BEFORE INSERT ON context_topic_versions
      WHEN NEW.topic_id = '${fourth.id}' AND NEW.version_number = 2
      BEGIN SELECT RAISE(ABORT, 'fixture write rejected'); END;`);
    expect(() => routeFounderFeedback(h.input, h.dependencies)).toThrow('fixture write rejected');
    expect(h.topicAt(2).currentVersion).toBe(1);
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 0 });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_sources').get()).toEqual({ n: 0 }); h.db.client.close();
  });
  it('fails closed when an already-captured source attributes the message to another actor', () => {
    const h = feedbackHarness(1);
    const c = captureGroupMessageSource({ chatId: h.input.chatId, messageId: h.input.messageId,
      threadId: h.input.replyTo, rootId: h.input.replyTo, author: { openId: 'ou_james', displayName: null },
      messageType: 'text', text: '暂停第 1 项', occurredAt: h.input.occurredAt }, feedbackNow);
    new ContextSourceRepository(h.db.client).saveSource(c.source);
    expect(routeFounderFeedback({ ...h.input, text: '暂停第 1 项' }, h.dependencies))
      .toMatchObject({ kind: 'reject', reason: 'message_conflict' });
    expect(h.topics.listCurrentTopics()[0]?.currentVersion).toBe(1); h.db.client.close();
  });
  it('stale work-map versions clarify without partial merge or audit/source writes', () => {
    const h = feedbackHarness(); const t = h.topicAt(4);
    h.topics.appendVersion({ ...t, topicId: t.id, expectedVersion: 1, changedAt: new Date(), rationale: 'newer' });
    expect(routeFounderFeedback(h.input, h.dependencies)).toMatchObject({ kind: 'clarify', reason: 'stale_context' });
    expect(h.topicAt(2).currentVersion).toBe(1); expect(h.topics.listRelations()).toEqual([]);
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_sources').get()).toEqual({ n: 0 });
    h.db.client.close();
  });
  it('split creates explicit child relations without deleting the parent or old evidence', () => {
    const h = feedbackHarness(1); const parent = h.created[0]!;
    expect(routeFounderFeedback({ ...h.input, text: '第 1 项拆分为 客户知识库 和 销售助手' }, h.dependencies).kind).toBe('corrected');
    expect(h.topics.listCurrentTopics()).toHaveLength(3);
    expect(h.topics.listVersions(parent.id)).toHaveLength(2);
    expect(h.topics.listRelations()).toMatchObject([{ relationType: 'split_from', toTopicId: parent.id }, { relationType: 'split_from', toTopicId: parent.id }]);
    h.db.client.close();
  });
  it('requires both configured founders on the same substantive resolution, never silence', () => {
    const h = alignmentHarness();
    expect(routeFounderFeedback(h.input, h.dependencies)).toMatchObject({ kind: 'corrected', status: 'awaiting_other_founder' });
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')).toBeNull();
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_j_reply', openId: 'ou_james', text: '收到' }, h.dependencies).kind).toBe('clarify');
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_j_reply', openId: 'ou_james', text: '同意，按 A 方案推进' }, h.dependencies))
      .toMatchObject({ kind: 'corrected', status: 'resolved' });
    expect(h.issues.get(h.candidate.id)?.status).toBe('resolved');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')?.evidenceIds).toHaveLength(2);
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 2 });
    h.db.client.close();
  });
  it('dismisses the reminder without manufacturing consensus', () => {
    const h = alignmentHarness();
    expect(routeFounderFeedback({ ...h.input, text: '不用提醒' }, h.dependencies)).toMatchObject({ correctionKind: 'dismiss_alignment', status: 'applied' });
    expect(h.issues.get(h.candidate.id)?.status).toBe('dismissed');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')).toBeNull(); h.db.client.close();
  });
  it.each(['如果客户同意，按 A 方案推进', 'Ivy 说按 A 方案推进', '双方都同意了', '同意，按 B 方案推进'])
  ('does not mark the issue resolved from %s', (text) => {
    const h = alignmentHarness(); routeFounderFeedback(h.input, h.dependencies);
    routeFounderFeedback({ ...h.input, messageId: 'om_j_other', openId: 'ou_james', text }, h.dependencies);
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked'); h.db.client.close();
  });
  it('checks the issue expected timestamp as well as status before any mutation', () => {
    const h = alignmentHarness();
    const result = applyTopicCorrection({ ...h.input, text: '不用提醒' }, { kind: 'dismiss_alignment', issue: {
      id: h.candidate.id, expectedStatus: 'asked', expectedUpdatedAt: '2026-09-21T09:59:00.000Z' } }, h.dependencies);
    expect(result).toMatchObject({ kind: 'clarify', reason: 'stale_context' });
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 0 }); h.db.client.close();
  });
  it('clarifies oversized resolution text instead of causing a webhook retry loop', () => {
    const h = alignmentHarness();
    expect(routeFounderFeedback({ ...h.input, text: `按${'方案'.repeat(600)}推进` }, h.dependencies).kind).toBe('clarify');
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked'); h.db.client.close();
  });
  it('does not use a pre-question founder statement to manufacture post-question consensus', () => {
    const h = alignmentHarness();
    routeFounderFeedback({ ...h.input, occurredAt: '2026-09-21T09:30:00.000Z' }, h.dependencies);
    routeFounderFeedback({ ...h.input, messageId: 'om_j_new', openId: 'ou_james', text: '同意，按 A 方案推进' }, h.dependencies);
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')).toBeNull(); h.db.client.close();
  });

  it('audits an out-of-order older reply without replacing the newer founder view or resolving from it', () => {
    const h = alignmentHarness();
    const reply = (messageId: string, openId: string, time: string, text: string) => routeFounderFeedback({
      ...h.input, messageId, openId, text, occurredAt: `2026-09-21T10:${time}:00.000Z`
    }, h.dependencies);
    reply('om_ivy_newer', 'ou_ivy', '03', '按 B 方案推进');
    expect(reply('om_ivy_older', 'ou_ivy', '02', '按 A 方案推进')).toMatchObject({ kind: 'corrected', status: 'historical_only' });
    reply('om_james_later', 'ou_james', '04', '同意，按 A 方案推进');
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'ivy_view')?.statement).toBe('按 B 方案推进');
    expect(h.alignment.listPerspectiveVersions(h.created[0]!.id, 'ivy_view')).toHaveLength(1);
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 3 });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_sources WHERE external_id = ?').get('om_ivy_older')).toEqual({ n: 1 });
    h.db.client.close();
  });

  it('keeps the first ingested same-time view and blocks ambiguous tied support until a newer statement', () => {
    const h = alignmentHarness();
    const send = (messageId: string, openId: string, minute: string, text: string) => routeFounderFeedback({ ...h.input,
      messageId, openId, text, occurredAt: `2026-09-21T10:${minute}:00.000Z` }, h.dependencies);
    send('om_z_first', 'ou_ivy', '02', '按 A 方案推进');
    expect(send('om_a_second', 'ou_ivy', '02', '按 B 方案推进')).toMatchObject({ status: 'historical_only' });
    send('om_j_matching_first', 'ou_james', '03', '同意，按 A 方案推进');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'ivy_view')?.statement).toBe('按 A 方案推进');
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')).toBeNull();
    send('om_ivy_new', 'ou_ivy', '04', '按 A 方案推进');
    expect(send('om_james_new', 'ou_james', '05', '同意，按 A 方案推进')).toMatchObject({ status: 'resolved' });
    h.db.client.close();
  });

  it.each(['我撤回刚才的方案', '我撤回之前的 A 方案，先不要按 A 推进', '撤回', '不同意', '我不同意',
    '不同意按 A 方案推进', '不要按 A 方案推进', '我不再支持刚才的方案'])
  ('invalidates old support through an immutable withdrawal: %s', (withdrawal) => {
    const h = alignmentHarness();
    routeFounderFeedback({ ...h.input, occurredAt: '2026-09-21T10:01:00.000Z' }, h.dependencies);
    const withdrawn = routeFounderFeedback({ ...h.input, messageId: 'om_withdrawal', text: withdrawal,
      occurredAt: '2026-09-21T10:02:00.000Z' }, h.dependencies);
    expect(withdrawn).toMatchObject({ kind: 'corrected', status: 'support_withdrawn' });
    const versions = h.alignment.listPerspectiveVersions(h.created[0]!.id, 'ivy_view');
    expect(versions).toHaveLength(2);
    expect(versions[0]?.statement).toBe('按 A 方案推进');
    expect(versions[1]).toMatchObject({ statement: withdrawal, speechAct: 'explicit_disagreement' });
    routeFounderFeedback({ ...h.input, messageId: 'om_j_after_withdrawal', openId: 'ou_james',
      text: '同意，按 A 方案推进', occurredAt: '2026-09-21T10:03:00.000Z' }, h.dependencies);
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')).toBeNull();
    routeFounderFeedback({ ...h.input, messageId: 'om_ivy_reproposes', text: '按 A 方案推进', occurredAt: '2026-09-21T10:04:00.000Z' }, h.dependencies);
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_j_reconfirms', openId: 'ou_james',
      text: '同意，按 A 方案推进', occurredAt: '2026-09-21T10:05:00.000Z' }, h.dependencies)).toMatchObject({ status: 'resolved' });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 5 });
    h.db.client.close();
  });

  it('does not reinterpret a conditional or quoted withdrawal as the founder changing their view', () => {
    const h = alignmentHarness();
    routeFounderFeedback(h.input, h.dependencies);
    for (const text of ['如果客户反对，我撤回刚才的方案', 'James说“撤回”']) {
      expect(routeFounderFeedback({ ...h.input, messageId: `om_${text}`, text,
        occurredAt: '2026-09-21T10:02:00.000Z' }, h.dependencies).kind).toBe('clarify');
    }
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'ivy_view')?.statement).toBe('按 A 方案推进');
    h.db.client.close();
  });

  it('does not let a late older withdrawal invalidate a newer explicit proposal', () => {
    const h = alignmentHarness();
    routeFounderFeedback({ ...h.input, occurredAt: '2026-09-21T10:03:00.000Z' }, h.dependencies);
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_late_old_withdrawal', text: '撤回',
      occurredAt: '2026-09-21T10:02:00.000Z' }, h.dependencies)).toMatchObject({ status: 'historical_only' });
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'ivy_view')?.statement).toBe('按 A 方案推进');
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_later_agreement', openId: 'ou_james', text: '同意，按 A 方案推进',
      occurredAt: '2026-09-21T10:04:00.000Z' }, h.dependencies)).toMatchObject({ status: 'resolved' });
    h.db.client.close();
  });
  it('does not pair an earlier agreement with a proposal that happened later in source time', () => {
    const h = alignmentHarness();
    routeFounderFeedback({ ...h.input, occurredAt: '2026-09-21T10:03:00.000Z' }, h.dependencies);
    routeFounderFeedback({ ...h.input, messageId: 'om_earlier_agreement', openId: 'ou_james', text: '同意，按 A 方案推进',
      occurredAt: '2026-09-21T10:02:00.000Z' }, h.dependencies);
    expect(h.issues.get(h.candidate.id)?.status).toBe('asked');
    expect(h.alignment.getCurrentPerspective(h.created[0]!.id, 'shared_decision')).toBeNull();
    h.db.client.close();
  });
});
