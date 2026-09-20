import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { AlignmentIssueRepository } from '../src/repositories/alignment-issue-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { AlignmentDetector } from '../src/services/alignment-detector.js';
import { AlignmentNotificationPolicy } from '../src/services/alignment-notification-policy.js';
import { PerspectiveReconciler } from '../src/services/perspective-reconciler.js';

const now = new Date('2026-09-21T10:00:00.000Z');
const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';
function setup(dimension: 'direction' | 'next_action' | 'owner' | 'deadline' | 'completion_standard' = 'direction') {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const alignment = new AlignmentRepository(db.client);
  for (const founder of ['ivy', 'james'] as const) alignment.configureFounderIdentity({ founder,
    sourceSystem: 'feishu', externalAuthorId: `ou_${founder}`, configuredAt: now });
  const topics = new TopicRepository(db.client);
  const topic = topics.createTopic({ displayName: '网站', stage: 'active_project', createdAt: now });
  const sources = new ContextSourceRepository(db.client);
  function evidence(id: string, author: string, text: string, at = '2026-09-21T09:00:00.000Z') {
    const capture = captureGroupMessageSource({ chatId, messageId: id, threadId: null, rootId: null,
      author: { openId: author, displayName: author }, text, messageType: 'text', occurredAt: at }, now);
    const source = sources.saveSource(capture.source).source;
    return sources.saveEvidence({ sourceId: source.id, excerpt: text,
      locator: { ...capture.messageLocator, sourceVersion: source.sourceVersion, contentHash: source.contentHash },
      evidenceLevel: 'primary_statement', capturedAt: now }).evidence.id;
  }
  const statements = {
    direction: ['按 A 方案推进', '按 B 方案推进'],
    next_action: ['先做页面预览', '先做客户访谈'],
    owner: ['Ivy 负责交付', 'James 负责交付'],
    deadline: ['周五截止交付', '周三截止交付'],
    completion_standard: ['三个页面通过验收', '五个页面通过验收']
  }[dimension];
  const ivyId = evidence('om_i', 'ou_ivy', `${statements[0]}，今天开始实施`);
  const jamesId = evidence('om_j', 'ou_james', `${statements[1]}，今天开始实施`);
  const proposal = { topicId: topic.id, decisionKey: 'website-release', dimension,
    ivy: { evidenceId: ivyId, statement: statements[0]! },
    james: { evidenceId: jamesId, statement: statements[1]! },
    actionConsequence: { evidenceId: ivyId, excerpt: '今天开始实施' },
    actionHorizon: { evidenceId: ivyId, excerpt: '今天', startsAt: '2026-09-21T00:00:00.000Z', endsAt: '2026-09-22T00:00:00.000Z' } };
  const detector = new AlignmentDetector();
  const issues = new AlignmentIssueRepository(db.client);
  const outbox = new OutboxRepository(db.client);
  const policy = new AlignmentNotificationPolicy(issues, alignment, outbox);
  return { db, alignment, topic, evidence, proposal, candidate: detector.propose(proposal), detector,
    issues, outbox, policy, message: { targetChatId: chatId, card: { schema: '2.0' } } };
}

describe('AlignmentNotificationPolicy', () => {
  it.each(['direction', 'next_action', 'owner', 'deadline', 'completion_standard'] as const)
  ('allows evidenced %s action divergence without enqueuing during evaluation', (dimension) => {
    const h = setup(dimension);
    expect(h.policy.evaluate(h.candidate, now)).toEqual({ send: true, reason: 'action_divergence' });
    expect(h.outbox.listAll()).toEqual([]);
  });

  it('silences brainstorming without action consequence', () => {
    const h = setup();
    expect(h.policy.evaluate(h.detector.propose({ ...h.proposal, actionConsequence: null }), now))
      .toEqual({ send: false, reason: 'no_action_consequence' });
  });

  it('requires independently attributed evidence from both founders', () => {
    const h = setup();
    for (const evidenceId of [h.proposal.ivy.evidenceId, 'missing',
      h.evidence('om_unknown', 'ou_unknown', '按 B 方案推进')]) {
      const candidate = h.detector.propose({ ...h.proposal, james: { evidenceId, statement: '按 B 方案推进' } });
      expect(h.policy.evaluate(candidate, now)).toEqual({ send: false, reason: 'missing_dual_evidence' });
    }
  });

  it('rejects unsupported consequence excerpts and missing, expired or reversed action windows', () => {
    const h = setup();
    expect(h.policy.evaluate(h.detector.propose({ ...h.proposal,
      actionConsequence: { evidenceId: h.proposal.ivy.evidenceId, excerpt: '虚构实施' } }), now))
      .toEqual({ send: false, reason: 'no_action_consequence' });
    for (const actionHorizon of [null, { ...h.proposal.actionHorizon, endsAt: '2026-09-21T08:00:00.000Z' },
      { ...h.proposal.actionHorizon, startsAt: '2026-09-23T00:00:00.000Z' }]) {
      expect(h.policy.evaluate(h.detector.propose({ ...h.proposal, actionHorizon }), now))
        .toEqual({ send: false, reason: 'outside_action_horizon' });
    }
  });

  it('does not fabricate divergent views by clipping or replacing a source statement', () => {
    const h = setup();
    expect(h.policy.evaluate(h.detector.propose({ ...h.proposal,
      ivy: { ...h.proposal.ivy, statement: '按 C 方案推进' } }), now))
      .toEqual({ send: false, reason: 'ungrounded_divergence' });
  });

  it.each(['如果客户确认，按 B 方案推进，今天开始实施', 'James 说“按 B 方案推进”，今天开始实施',
    '不按 B 方案推进，今天开始实施', '也许按 B 方案推进，今天开始实施'])
  ('does not turn hypothetical, quoted or negated source text into a firm action: %s', (text) => {
    const h = setup(); const id = h.evidence('om_unsafe', 'ou_james', text);
    const candidate = h.detector.propose({ ...h.proposal, james: { evidenceId: id, statement: '按 B 方案推进' } });
    expect(h.policy.evaluate(candidate, now)).toEqual({ send: false, reason: 'ungrounded_divergence' });
  });

  it('does not borrow an unrelated founder action to justify a brainstorming difference', () => {
    const h = setup(); const id = h.evidence('om_unrelated', 'ou_ivy', '今天开始实施另一个项目');
    expect(h.policy.evaluate(h.detector.propose({ ...h.proposal,
      actionConsequence: { evidenceId: id, excerpt: '今天开始实施另一个项目' } }), now))
      .toEqual({ send: false, reason: 'no_action_consequence' });
  });

  it.each([
    ['今天不开始实施', '开始实施'],
    ['今天不会开始实施', '开始实施'],
    ['今天开始实施的承诺已撤回', '今天开始实施'],
    ['今天开始实施的计划已取消', '今天开始实施'],
    ['James 说今天开始实施', '今天开始实施'],
    ['听说今天开始实施', '今天开始实施'],
    ['We will not start implementation today', 'start implementation today'],
    ['Starting implementation today was cancelled', 'Starting implementation today'],
    ['James said start implementation today', 'start implementation today']
  ])('rejects non-affirmative action in the full immutable message: %s', (sourceAction, excerpt) => {
    const h = setup();
    const id = h.evidence('om_action_unsafe', 'ou_ivy', `按 A 方案推进，${sourceAction}`);
    const candidate = h.detector.propose({ ...h.proposal,
      ivy: { evidenceId: id, statement: '按 A 方案推进' },
      actionConsequence: { evidenceId: id, excerpt },
      actionHorizon: { ...h.proposal.actionHorizon, evidenceId: h.proposal.james.evidenceId }
    });
    expect(h.policy.evaluate(candidate, now)).toEqual({ send: false, reason: 'no_action_consequence' });
    expect(h.policy.prepare(candidate, h.message, now).send).toBe(false);
    expect(h.outbox.listAll()).toEqual([]);
  });

  it('rejects manipulated candidate hashes or windows at evaluation, not just persistence', () => {
    const h = setup();
    expect(h.policy.evaluate({ ...h.candidate, evidenceSetHash: 'invented' }, now))
      .toEqual({ send: false, reason: 'ungrounded_divergence' });
    expect(h.policy.evaluate({ ...h.candidate, actionHorizon: { ...h.proposal.actionHorizon, endsAt: 'invalid' } }, now))
      .toEqual({ send: false, reason: 'ungrounded_divergence' });
  });

  it('rolls back policy ready state if outbox insertion fails', () => {
    const h = setup(); h.issues.saveCandidate(h.candidate, now);
    h.db.client.exec(`CREATE TRIGGER reject_alignment_queue BEFORE INSERT ON outbox
      BEGIN SELECT RAISE(ABORT, 'queue failed'); END`);
    expect(() => h.policy.prepare(h.candidate, h.message, now)).toThrow(/queue failed/);
    expect(h.issues.get(h.candidate.id)?.status).toBe('candidate');
    expect(h.outbox.listAll()).toEqual([]);
  });

  it.each(['resolved', 'dismissed', 'stale'] as const)('never reopens %s on unchanged evidence', (status) => {
    const h = setup(); h.policy.prepare(h.candidate, h.message, now);
    h.issues.close({ issueId: h.candidate.id, expectedStatus: 'ready', status, changedAt: now });
    expect(h.policy.prepare(h.candidate, h.message, now)).toEqual({ send: false, reason: 'unchanged_evidence' });
    expect(h.outbox.listPendingAlignmentQuestions(now)).toEqual([]);
  });

  it('suppresses a discussion naturally resolved later by a supported shared decision', () => {
    const h = setup();
    h.policy.prepare(h.candidate, h.message, now);
    const reconciler = new PerspectiveReconciler(h.alignment);
    const ivy = h.evidence('om_res_i', 'ou_ivy', '按 A 方案推进', '2026-09-21T09:30:00.000Z');
    const james = h.evidence('om_res_j', 'ou_james', '同意按 A 方案推进', '2026-09-21T09:31:00.000Z');
    reconciler.reconcile({ topicId: h.topic.id, evidenceId: ivy, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: h.proposal.decisionKey, confidence: 1,
      observedAt: new Date('2026-09-21T09:30:00.000Z') });
    reconciler.reconcile({ topicId: h.topic.id, evidenceId: james, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: h.proposal.decisionKey, confidence: 1,
      observedAt: new Date('2026-09-21T09:31:00.000Z') });
    expect(h.policy.evaluate(h.candidate, now)).toEqual({ send: false, reason: 'naturally_resolved' });
    h.policy.reconcilePending(now);
    expect(h.issues.get(h.candidate.id)?.status).toBe('resolved');
    expect(h.outbox.listPendingAlignmentQuestions(now)).toEqual([]);
  });

  it.each([false, true])('keeps decision A resolved when B becomes the latest shared perspective (already queued: %s)', (queued) => {
    const h = setup();
    if (queued) h.policy.prepare(h.candidate, h.message, now);
    const reconciler = new PerspectiveReconciler(h.alignment);
    for (const [key, plan, hour] of [[h.proposal.decisionKey, 'A', '09:30'], ['website-owner', 'C', '09:40']]) {
      const statement = `按 ${plan} 方案推进`;
      const proposalAt = `2026-09-21T${hour}:00.000Z`;
      const agreementAt = `2026-09-21T${hour}:30.000Z`;
      const i = h.evidence(`om_${plan}_proposal`, 'ou_ivy', statement, proposalAt);
      const j = h.evidence(`om_${plan}_agreement`, 'ou_james', `同意${statement}`, agreementAt);
      reconciler.reconcile({ topicId: h.topic.id, evidenceId: i, statement, speechAct: 'decision_proposal',
        decisionKey: key!, confidence: 1, observedAt: new Date(proposalAt) });
      reconciler.reconcile({ topicId: h.topic.id, evidenceId: j, statement: `同意${statement}`, speechAct: 'explicit_agreement',
        decisionKey: key!, confidence: 1, observedAt: new Date(agreementAt) });
    }
    expect(h.alignment.getCurrentPerspective(h.topic.id, 'shared_decision')?.decisionKey).toBe('website-owner');
    expect(h.policy.evaluate(h.candidate, now)).toEqual({ send: false, reason: 'naturally_resolved' });
    expect(h.policy.prepare(h.candidate, h.message, now)).toEqual({ send: false, reason: 'naturally_resolved' });
    h.policy.reconcilePending(now);
    expect(h.issues.get(h.candidate.id)?.status).toBe(queued ? 'resolved' : undefined);
    expect(h.outbox.listPendingAlignmentQuestions(now)).toEqual([]);
  });

  it('suppresses unchanged evidence and another open issue even across process restarts', () => {
    const h = setup();
    expect(h.policy.prepare(h.candidate, h.message, now)).toMatchObject({ send: true });
    const fresh = new AlignmentNotificationPolicy(new AlignmentIssueRepository(h.db.client), h.alignment, h.outbox);
    expect(fresh.evaluate(h.detector.propose(h.proposal), now)).toEqual({ send: false, reason: 'unchanged_evidence' });
    const id = h.evidence('om_new', 'ou_james', '按 C 方案推进');
    expect(fresh.evaluate(h.detector.propose({ ...h.proposal, james: { evidenceId: id, statement: '按 C 方案推进' } }), now))
      .toEqual({ send: false, reason: 'open_issue_exists' });
    expect(h.outbox.listAll()).toHaveLength(1);
  });

  it('does not resend unchanged evidence when analysis renames the decision key', () => {
    const h = setup(); h.policy.prepare(h.candidate, h.message, now);
    expect(h.policy.evaluate(h.detector.propose({ ...h.proposal, decisionKey: 'renamed-release' }), now))
      .toEqual({ send: false, reason: 'unchanged_evidence' });
  });

  it('does not resend a dismissed divergence merely because its unchanged views were repeated', () => {
    const h = setup(); h.policy.prepare(h.candidate, h.message, now);
    h.issues.close({ issueId: h.candidate.id, expectedStatus: 'ready', status: 'dismissed', changedAt: now });
    const repeated = h.evidence('om_repeat', 'ou_james', '按 B 方案推进，今天开始实施');
    expect(h.policy.evaluate(h.detector.propose({ ...h.proposal,
      james: { ...h.proposal.james, evidenceId: repeated } }), now))
      .toEqual({ send: false, reason: 'unchanged_evidence' });
  });

  it('does not suppress a later conflict using an older shared decision', () => {
    const h = setup();
    const i = h.evidence('om_old_i', 'ou_ivy', '按 A 方案推进', '2026-09-21T07:00:00.000Z');
    const j = h.evidence('om_old_j', 'ou_james', '同意按 A 方案推进', '2026-09-21T07:10:00.000Z');
    const reconciler = new PerspectiveReconciler(h.alignment);
    reconciler.reconcile({ topicId: h.topic.id, evidenceId: i, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: h.proposal.decisionKey, confidence: 1,
      observedAt: now });
    reconciler.reconcile({ topicId: h.topic.id, evidenceId: j, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: h.proposal.decisionKey, confidence: 1,
      observedAt: now });
    expect(h.policy.evaluate(h.candidate, now)).toEqual({ send: true, reason: 'action_divergence' });
  });

  it('retires an expired pending question before another delivery tick', () => {
    const h = setup(); h.policy.prepare(h.candidate, h.message, now);
    h.policy.reconcilePending(new Date('2026-09-22T01:00:00.000Z'));
    expect(h.issues.get(h.candidate.id)?.status).toBe('stale');
    expect(h.outbox.listPendingAlignmentQuestions(new Date('2026-09-22T01:00:00.000Z'))).toEqual([]);
  });

  it('only acknowledges asked together with a real delivered message ID, and retries reuse one key', () => {
    const h = setup(); h.policy.prepare(h.candidate, h.message, now);
    const key = `alignment-question:${h.candidate.id}:${h.candidate.evidenceSetHash}`;
    const identity = { issueId: h.candidate.id, evidenceSetHash: h.candidate.evidenceSetHash };
    expect(h.issues.get(h.candidate.id)?.status).toBe('ready');
    h.outbox.markAlignmentQuestionRetry({ ...identity, errorCode: 'SEND_FAILED', retryAt: new Date('2026-09-21T10:01:00.000Z') });
    expect(h.outbox.listPendingAlignmentQuestions(now)).toEqual([]);
    expect(h.outbox.listPendingAlignmentQuestions(new Date('2026-09-21T10:02:00.000Z'))).toHaveLength(1);
    expect(h.db.client.prepare('SELECT idempotency_key, attempt_count FROM outbox').get())
      .toEqual({ idempotency_key: key, attempt_count: 1 });
    expect(() => h.outbox.acknowledgeAlignmentQuestionDelivery({ ...identity, messageId: 'pending:fake', deliveredAt: now })).toThrow();
    expect(h.issues.get(h.candidate.id)?.status).toBe('ready');
    expect(h.outbox.acknowledgeAlignmentQuestionDelivery({ ...identity, messageId: 'om_delivered', deliveredAt: now }))
      .toEqual({ updated: true });
    expect(h.issues.get(h.candidate.id)).toMatchObject({ status: 'asked', deliveredMessageId: 'om_delivered' });
    expect(h.outbox.acknowledgeAlignmentQuestionDelivery({ ...identity, messageId: 'om_delivered', deliveredAt: now }))
      .toEqual({ updated: false });
    expect(() => h.outbox.acknowledgeAlignmentQuestionDelivery({ ...identity, messageId: 'om_other', deliveredAt: now })).toThrow();
  });

  it('rolls back issue state when delivery acknowledgement fails after the issue update', () => {
    const h = setup(); h.policy.prepare(h.candidate, h.message, now);
    h.db.client.exec(`CREATE TRIGGER reject_alignment_ack BEFORE UPDATE ON outbox
      WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'ack failed'); END`);
    expect(() => h.outbox.acknowledgeAlignmentQuestionDelivery({ issueId: h.candidate.id,
      evidenceSetHash: h.candidate.evidenceSetHash, messageId: 'om_failed', deliveredAt: now })).toThrow(/ack failed/);
    expect(h.issues.get(h.candidate.id)?.status).toBe('ready');
    expect(h.db.client.prepare('SELECT status FROM outbox').get()).toEqual({ status: 'pending' });
  });

  it('cannot enqueue a model candidate directly; terminal issues are not sent or reopened', () => {
    const h = setup(); h.issues.saveCandidate(h.candidate, now);
    const message = { kind: 'alignment_question' as const, ...h.message,
      issueId: h.candidate.id, evidenceSetHash: h.candidate.evidenceSetHash };
    expect(() => h.outbox.enqueueAlignmentQuestion(message, now)).toThrow();
    h.policy.prepare(h.candidate, h.message, now);
    h.issues.close({ issueId: h.candidate.id, expectedStatus: 'ready', status: 'dismissed', changedAt: now });
    expect(h.outbox.listPendingAlignmentQuestions(now)).toEqual([]);
    expect(h.policy.evaluate(h.candidate, now)).toEqual({ send: false, reason: 'unchanged_evidence' });
    expect(() => h.issues.close({ issueId: h.candidate.id, expectedStatus: 'ready', status: 'resolved', changedAt: now })).toThrow();
    migrateDatabase(h.db.client);
    expect(h.issues.get(h.candidate.id)?.status).toBe('dismissed');
    expect(() => h.db.client.prepare("UPDATE alignment_issues SET status = 'open'").run()).toThrow();
  });
});
