import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { PerspectiveReconciler } from '../src/services/perspective-reconciler.js';

function createHarness() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const topic = new TopicRepository(database.client).createTopic({
    displayName: '销售知识库',
    stage: 'exploring',
    createdAt: new Date('2026-09-01T00:00:00.000Z')
  });
  const repository = new AlignmentRepository(database.client);
  repository.configureFounderIdentity({
    founder: 'ivy', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy',
    configuredAt: new Date('2026-09-01T00:00:00.000Z')
  });
  repository.configureFounderIdentity({
    founder: 'james', sourceSystem: 'feishu', externalAuthorId: 'ou_james',
    configuredAt: new Date('2026-09-01T00:00:00.000Z')
  });
  return {
    database,
    topic,
    repository,
    sources: new ContextSourceRepository(database.client),
    reconciler: new PerspectiveReconciler(repository)
  };
}

function saveGroupEvidence(
  sources: ContextSourceRepository,
  input: { messageId: string; openId: string | null; displayName: string; text: string; occurredAt: string }
): string {
  const captured = captureGroupMessageSource({
    chatId: 'oc_founder_stream', messageId: input.messageId, threadId: null, rootId: null,
    author: { openId: input.openId, displayName: input.displayName },
    messageType: 'text', text: input.text, occurredAt: input.occurredAt
  }, new Date(input.occurredAt));
  const source = sources.saveSource(captured.source).source;
  return sources.saveEvidence({
    sourceId: source.id,
    excerpt: input.text,
    locator: { ...captured.messageLocator, sourceVersion: source.sourceVersion, contentHash: source.contentHash },
    evidenceLevel: 'primary_statement',
    capturedAt: new Date(input.occurredAt)
  }).evidence.id;
}

describe('PerspectiveReconciler', () => {
  it('keeps an unknown sender unknown even when its display name says Ivy', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const evidenceId = saveGroupEvidence(sources, {
      messageId: 'om_unknown_ivy', openId: 'ou_not_configured', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T00:30:00.000Z'
    });

    expect(reconciler.reconcile({
      topicId: topic.id, evidenceId, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T00:30:00.000Z')
    })).toEqual({
      founder: null, status: 'ignored', reason: 'unknown_identity', versions: []
    });
    expect(repository.listCurrentPerspectives(topic.id)).toEqual([]);
  });

  it('updates only Ivy view and never turns a later unrelated James message into consensus', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_proposal', openId: 'ou_ivy', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_later', openId: 'ou_james', displayName: 'James',
      text: '晚点再看数据', occurredAt: '2026-09-01T02:00:00.000Z'
    });

    reconciler.reconcile({
      topicId: topic.id,
      evidenceId: ivyEvidenceId,
      statement: '按 A 方案推进',
      speechAct: 'decision_proposal',
      decisionKey: 'sales-kb-direction',
      confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id,
      evidenceId: jamesEvidenceId,
      statement: '晚点再看数据',
      speechAct: 'non_decision',
      decisionKey: null,
      confidence: 0.9,
      observedAt: new Date('2026-09-01T02:00:00.000Z')
    });

    expect(repository.listCurrentPerspectives(topic.id)).toEqual([
      expect.objectContaining({
        kind: 'ivy_view',
        statement: '按 A 方案推进',
        evidenceIds: [ivyEvidenceId]
      })
    ]);
    expect(repository.getCurrentPerspective(topic.id, 'james_view')).toBeNull();
    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
    expect(repository.getCurrentPerspective(topic.id, 'unresolved')).toBeNull();
  });

  it('creates a shared decision only after explicit support from both configured founders', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_decision', openId: 'ou_ivy', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_agreement', openId: 'ou_james', displayName: 'James',
      text: '同意按 A 方案推进', occurredAt: '2026-09-01T01:05:00.000Z'
    });

    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    const result = reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.98,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(result.versions.map((version) => version.kind)).toEqual([
      'james_view', 'shared_decision'
    ]);
    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toMatchObject({
      statement: '按 A 方案推进',
      speechAct: 'explicit_agreement',
      decisionKey: 'sales-kb-direction',
      evidenceIds: [ivyEvidenceId, jamesEvidenceId]
    });
  });

  it('commits a founder agreement and its shared decision atomically', () => {
    const { database, repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_atomic', openId: 'ou_ivy', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_atomic', openId: 'ou_james', displayName: 'James',
      text: '同意按 A 方案推进', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    database.client.exec(`
      CREATE TRIGGER reject_shared_decision_version
      BEFORE INSERT ON topic_perspective_versions
      WHEN (SELECT kind FROM topic_perspectives WHERE id = NEW.perspective_id) = 'shared_decision'
      BEGIN
        SELECT RAISE(ABORT, 'shared write rejected');
      END
    `);

    expect(() => reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.98,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    })).toThrow(/shared write rejected/);
    expect(repository.getCurrentPerspective(topic.id, 'james_view')).toBeNull();
    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
  });

  it('does not trust an agreement label when the cited message only says read or later', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_proposal_2', openId: 'ou_ivy', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_read', openId: 'ou_james', displayName: 'James',
      text: '收到，晚点看', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: '收到，晚点看',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
  });

  it.each([
    ['Chinese negation', '我不同意按 A 方案推进', '同意按 A 方案推进'],
    ['Chinese rejection', '我不赞成按 A 方案推进', '赞成按 A 方案推进'],
    ['English negation', 'I do not agree to proceed with A', 'agree to proceed with A'],
    ['conditional support', '如果客户确认，我同意按 A 方案推进', '同意按 A 方案推进'],
    ['English conditional support', 'I agree to proceed with A subject to customer approval',
      'agree to proceed with A'],
    ['quoted support', 'James 说“同意按 A 方案推进”', '同意按 A 方案推进'],
    ['truncated support', '同意按 A 方案推进……', '同意按 A 方案推进']
  ])('rejects mislabeled %s after checking the complete source message',
    (_label, sourceText, modelStatement) => {
      const { repository, sources, topic, reconciler } = createHarness();
      const ivyEvidenceId = saveGroupEvidence(sources, {
        messageId: 'om_ivy_safe_proposal', openId: 'ou_ivy', displayName: 'Ivy',
        text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
      });
      const jamesEvidenceId = saveGroupEvidence(sources, {
        messageId: 'om_james_unsafe_agreement', openId: 'ou_james', displayName: 'James',
        text: sourceText, occurredAt: '2026-09-01T01:05:00.000Z'
      });
      reconciler.reconcile({
        topicId: topic.id, evidenceId: ivyEvidenceId, statement: '按 A 方案推进',
        speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
        observedAt: new Date('2026-09-01T01:00:00.000Z')
      });
      reconciler.reconcile({
        topicId: topic.id, evidenceId: jamesEvidenceId, statement: modelStatement,
        speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.99,
        observedAt: new Date('2026-09-01T01:05:00.000Z')
      });

      expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
    });

  it.each([
    ['an acknowledgement', '收到，晚点看'],
    ['a conditional proposal', '如果客户确认，就按 A 方案推进'],
    ['a quoted proposal', 'Ivy 说“按 A 方案推进”'],
    ['a truncated proposal', '按 A 方案推进...']
  ])('rejects a mislabeled proposal that is only %s', (_label, proposalText) => {
    const { repository, sources, topic, reconciler } = createHarness();
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_unsafe_proposal', openId: 'ou_james', displayName: 'James',
      text: proposalText, occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_agreement_after_unsafe_proposal', openId: 'ou_ivy', displayName: 'Ivy',
      text: '同意按 A 方案推进', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: proposalText,
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
  });

  it('does not use a matching decision key to reconcile different substantive decisions', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_b_proposal', openId: 'ou_james', displayName: 'James',
      text: '按 B 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_agrees_a', openId: 'ou_ivy', displayName: 'Ivy',
      text: '同意按 A 方案推进', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: '按 B 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
  });

  it('accepts matching direct English proposal and agreement evidence', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_english_proposal', openId: 'ou_ivy', displayName: 'Ivy',
      text: 'Proceed with plan A', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_english_agreement', openId: 'ou_james', displayName: 'James',
      text: 'I agree to proceed with plan A', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: 'Proceed with plan A',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId,
      statement: 'I agree to proceed with plan A', speechAct: 'explicit_agreement',
      decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toMatchObject({
      statement: 'Proceed with plan A',
      evidenceIds: [ivyEvidenceId, jamesEvidenceId]
    });
  });

  it('never reuses a read-or-later message as the other founders supporting evidence', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const jamesProposal = saveGroupEvidence(sources, {
      messageId: 'om_james_proposal', openId: 'ou_james', displayName: 'James',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const ivyRead = saveGroupEvidence(sources, {
      messageId: 'om_ivy_read', openId: 'ou_ivy', displayName: 'Ivy',
      text: '收到，晚点看', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    const jamesAgreement = saveGroupEvidence(sources, {
      messageId: 'om_james_agrees_again', openId: 'ou_james', displayName: 'James',
      text: '同意按 A 方案推进', occurredAt: '2026-09-01T01:10:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesProposal, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyRead, statement: '收到，晚点看',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesAgreement, statement: '同意按 A 方案推进',
      speechAct: 'explicit_agreement', decisionKey: 'sales-kb-direction', confidence: 0.99,
      observedAt: new Date('2026-09-01T01:10:00.000Z')
    });

    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
  });

  it('keeps explicit disagreement unresolved with both founders evidence', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_a', openId: 'ou_ivy', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_b', openId: 'ou_james', displayName: 'James',
      text: '不同意 A，先做 B', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });

    const result = reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: '不同意 A，先做 B',
      speechAct: 'explicit_disagreement', decisionKey: 'sales-kb-direction', confidence: 0.97,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(result.versions.map((version) => version.kind)).toEqual([
      'james_view', 'unresolved'
    ]);
    expect(repository.getCurrentPerspective(topic.id, 'unresolved')).toMatchObject({
      statement: '不同意 A，先做 B',
      speechAct: 'explicit_disagreement',
      evidenceIds: [ivyEvidenceId, jamesEvidenceId]
    });
    expect(repository.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
  });

  it('does not create unresolved from a disagreement label without explicit disagreement text', () => {
    const { repository, sources, topic, reconciler } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_proposal_3', openId: 'ou_ivy', displayName: 'Ivy',
      text: '按 A 方案推进', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const jamesEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_james_think', openId: 'ou_james', displayName: 'James',
      text: '我再想想', occurredAt: '2026-09-01T01:05:00.000Z'
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: ivyEvidenceId, statement: '按 A 方案推进',
      speechAct: 'decision_proposal', decisionKey: 'sales-kb-direction', confidence: 0.95,
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    reconciler.reconcile({
      topicId: topic.id, evidenceId: jamesEvidenceId, statement: '我再想想',
      speechAct: 'explicit_disagreement', decisionKey: 'sales-kb-direction', confidence: 0.8,
      observedAt: new Date('2026-09-01T01:05:00.000Z')
    });

    expect(repository.getCurrentPerspective(topic.id, 'unresolved')).toBeNull();
  });
});
