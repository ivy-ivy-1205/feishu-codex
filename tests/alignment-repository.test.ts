import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import {
  AlignmentRepository,
  PerspectiveVersionConflictError
} from '../src/repositories/alignment-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

function createHarness() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const topics = new TopicRepository(database.client);
  const topic = topics.createTopic({
    displayName: '销售知识库',
    stage: 'exploring',
    createdAt: new Date('2026-09-01T00:00:00.000Z')
  });
  return {
    database,
    topic,
    repository: new AlignmentRepository(database.client),
    sources: new ContextSourceRepository(database.client)
  };
}

function saveGroupEvidence(
  sources: ContextSourceRepository,
  input: { messageId: string; openId: string | null; displayName: string; text: string; occurredAt: string }
): string {
  const captured = captureGroupMessageSource({
    chatId: 'oc_founder_stream',
    messageId: input.messageId,
    threadId: null,
    rootId: null,
    author: { openId: input.openId, displayName: input.displayName },
    messageType: 'text',
    text: input.text,
    occurredAt: input.occurredAt
  }, new Date(input.occurredAt));
  const saved = sources.saveSource(captured.source).source;
  return sources.saveEvidence({
    sourceId: saved.id,
    excerpt: input.text,
    locator: {
      ...captured.messageLocator,
      sourceVersion: saved.sourceVersion,
      contentHash: saved.contentHash
    },
    evidenceLevel: 'primary_statement',
    capturedAt: new Date(input.occurredAt)
  }).evidence.id;
}

describe('AlignmentRepository', () => {
  it('attributes evidence only through configured immutable founder identities', () => {
    const { repository, sources } = createHarness();
    const ivyEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy', openId: 'ou_ivy', displayName: 'Ivy',
      text: '这是 Ivy 的观点', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const unknownEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_unknown', openId: 'ou_unknown', displayName: 'Ivy',
      text: '显示名不能充当身份', occurredAt: '2026-09-01T01:01:00.000Z'
    });

    const identity = repository.configureFounderIdentity({
      founder: 'ivy', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy',
      configuredAt: new Date('2026-09-01T00:00:00.000Z')
    });

    expect(repository.configureFounderIdentity({
      founder: 'ivy', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy',
      configuredAt: new Date('2026-09-02T00:00:00.000Z')
    })).toEqual(identity);
    expect(repository.resolveFounderForEvidence(ivyEvidenceId)).toBe('ivy');
    expect(repository.resolveFounderForEvidence(unknownEvidenceId)).toBeNull();
    expect(() => repository.configureFounderIdentity({
      founder: 'james', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy',
      configuredAt: new Date('2026-09-03T00:00:00.000Z')
    })).toThrowError(expect.objectContaining({ code: 'FOUNDER_IDENTITY_CONFLICT' }));
  });

  it('appends immutable perspective versions with evidence and rejects a stale CAS write', () => {
    const { repository, sources, topic } = createHarness();
    const firstEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_1', openId: 'ou_ivy', displayName: 'Ivy',
      text: '先按 A 方案做一版', occurredAt: '2026-09-01T01:00:00.000Z'
    });
    const secondEvidenceId = saveGroupEvidence(sources, {
      messageId: 'om_ivy_2', openId: 'ou_ivy', displayName: 'Ivy',
      text: 'A 方案先覆盖销售团队', occurredAt: '2026-09-02T01:00:00.000Z'
    });

    const first = repository.savePerspective({
      topicId: topic.id,
      kind: 'ivy_view',
      expectedVersion: 0,
      statement: '先按 A 方案做一版',
      confidence: 0.9,
      evidenceIds: [firstEvidenceId],
      decisionKey: 'sales-kb-direction',
      speechAct: 'decision_proposal',
      observedAt: new Date('2026-09-01T01:00:00.000Z')
    });
    const second = repository.savePerspective({
      topicId: topic.id,
      kind: 'ivy_view',
      expectedVersion: first.versionNumber,
      statement: 'A 方案先覆盖销售团队',
      confidence: 0.95,
      evidenceIds: [firstEvidenceId, secondEvidenceId],
      decisionKey: 'sales-kb-direction',
      speechAct: 'view',
      observedAt: new Date('2026-09-02T01:00:00.000Z')
    });

    expect(second.versionNumber).toBe(2);
    expect(repository.listPerspectiveVersions(topic.id, 'ivy_view')).toEqual([
      expect.objectContaining({
        versionNumber: 1,
        statement: '先按 A 方案做一版',
        evidenceIds: [firstEvidenceId]
      }),
      expect.objectContaining({
        versionNumber: 2,
        statement: 'A 方案先覆盖销售团队',
        evidenceIds: [firstEvidenceId, secondEvidenceId]
      })
    ]);
    expect(repository.getCurrentPerspective(topic.id, 'ivy_view')).toMatchObject({
      versionNumber: 2,
      statement: 'A 方案先覆盖销售团队'
    });
    expect(() => repository.savePerspective({
      topicId: topic.id,
      kind: 'ivy_view',
      expectedVersion: 1,
      statement: '过期写入',
      confidence: 1,
      evidenceIds: [firstEvidenceId],
      decisionKey: 'sales-kb-direction',
      speechAct: 'view',
      observedAt: new Date('2026-09-03T01:00:00.000Z')
    })).toThrowError(expect.objectContaining({
      name: PerspectiveVersionConflictError.name,
      code: 'PERSPECTIVE_VERSION_CONFLICT'
    }));
    expect(repository.listPerspectiveVersions(topic.id, 'ivy_view')).toHaveLength(2);
  });
});
