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
  it('projects current perspectives across an explicit same_as component and keeps distinct decision keys', () => {
    const { repository, sources, topic, database } = createHarness();
    const duplicate = new TopicRepository(database.client).createTopic({displayName:'销售知识库副本',stage:'exploring',createdAt:new Date('2026-09-01T00:01:00Z')});
    new TopicRepository(database.client).addRelation({fromTopicId:topic.id,toTopicId:duplicate.id,relationType:'same_as',rationale:'confirmed',createdAt:new Date('2026-09-01T00:02:00Z')});
    const first=saveGroupEvidence(sources,{messageId:'om_a',openId:'ou_james',displayName:'James',text:'先整理销售方法',occurredAt:'2026-09-01T01:00:00Z'});
    const later=saveGroupEvidence(sources,{messageId:'om_b',openId:'ou_james',displayName:'James',text:'先等判断语录',occurredAt:'2026-09-02T01:00:00Z'});
    repository.savePerspective({topicId:topic.id,kind:'james_view',expectedVersion:0,statement:'先整理销售方法',confidence:1,evidenceIds:[first],decisionKey:'method',speechAct:'view',observedAt:new Date('2026-09-01T01:00:00Z')});
    repository.savePerspective({topicId:duplicate.id,kind:'james_view',expectedVersion:0,statement:'先等判断语录',confidence:1,evidenceIds:[later],decisionKey:'next',speechAct:'view',observedAt:new Date('2026-09-02T01:00:00Z')});
    expect(repository.listCanonicalPerspectives(topic.id).map(value=>value.decisionKey)).toEqual(['method','next']);
  });

  it('collapses the same founder statement across synonymous decision keys without losing evidence', () => {
    const { repository, sources, topic, database } = createHarness();
    const duplicate = new TopicRepository(database.client).createTopic({displayName:'销售知识库副本',stage:'exploring',createdAt:new Date('2026-09-01T00:01:00Z')});
    new TopicRepository(database.client).addRelation({fromTopicId:topic.id,toTopicId:duplicate.id,relationType:'same_as',rationale:'confirmed',createdAt:new Date('2026-09-01T00:02:00Z')});
    const first=saveGroupEvidence(sources,{messageId:'om_same_a',openId:'ou_ivy',displayName:'Ivy',text:'一个 Amy 持续服务客户。',occurredAt:'2026-09-01T01:00:00Z'});
    const later=saveGroupEvidence(sources,{messageId:'om_same_b',openId:'ou_ivy',displayName:'Ivy',text:'一个Amy持续服务客户',occurredAt:'2026-09-02T01:00:00Z'});
    repository.savePerspective({topicId:topic.id,kind:'ivy_view',expectedVersion:0,statement:'一个 Amy 持续服务客户。',confidence:1,evidenceIds:[first],decisionKey:'amy_continuous_service_model',speechAct:'decision_proposal',observedAt:new Date('2026-09-01T01:00:00Z')});
    repository.savePerspective({topicId:duplicate.id,kind:'ivy_view',expectedVersion:0,statement:'一个Amy持续服务客户',confidence:1,evidenceIds:[later],decisionKey:'Amy核心服务架构',speechAct:'decision_proposal',observedAt:new Date('2026-09-02T01:00:00Z')});

    expect(repository.listCanonicalPerspectives(topic.id)).toEqual([
      expect.objectContaining({
        statement: '一个Amy持续服务客户',
        decisionKey: 'Amy核心服务架构',
        evidenceIds: [first, later]
      })
    ]);
  });
  it('collapses a same-time prefixed restatement from the same founder', () => {
    const { repository, sources, topic, database } = createHarness();
    const duplicate = new TopicRepository(database.client).createTopic({displayName:'对齐室副本',stage:'active_project',createdAt:new Date('2026-09-01T00:01:00Z')});
    new TopicRepository(database.client).addRelation({fromTopicId:topic.id,toTopicId:duplicate.id,relationType:'same_as',rationale:'confirmed',createdAt:new Date('2026-09-01T00:02:00Z')});
    const long='建议的目标：每周减少的重复解释、查找和返工时间，明显高于系统维护的新增成本。';
    const short='每周减少的重复解释、查找和返工时间，明显高于系统维护的新增成本。';
    const first=saveGroupEvidence(sources,{messageId:'om_goal_a',openId:'ou_james',displayName:'James',text:long,occurredAt:'2026-09-02T01:00:00Z'});
    const second=saveGroupEvidence(sources,{messageId:'om_goal_b',openId:'ou_james',displayName:'James',text:short,occurredAt:'2026-09-02T01:00:00Z'});
    repository.savePerspective({topicId:topic.id,kind:'james_view',expectedVersion:0,statement:long,confidence:1,evidenceIds:[first],decisionKey:'success_standard',speechAct:'view',observedAt:new Date('2026-09-02T01:00:00Z')});
    repository.savePerspective({topicId:duplicate.id,kind:'james_view',expectedVersion:0,statement:short,confidence:1,evidenceIds:[second],decisionKey:'effect_standard',speechAct:'view',observedAt:new Date('2026-09-02T01:00:00Z')});

    const result=repository.listCanonicalPerspectives(topic.id);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ statement: short }));
    expect(new Set(result[0]!.evidenceIds)).toEqual(new Set([first,second]));
  });
  it('collapses a contained same-day update while retaining the more informative statement', () => {
    const { repository, sources, topic, database } = createHarness();
    const duplicate = new TopicRepository(database.client).createTopic({displayName:'选房经验副本',stage:'active_project',createdAt:new Date('2026-09-01T00:01:00Z')});
    new TopicRepository(database.client).addRelation({fromTopicId:topic.id,toTopicId:duplicate.id,relationType:'same_as',rationale:'confirmed',createdAt:new Date('2026-09-01T00:02:00Z')});
    const long='我的已经做完，然后等 Jimmy 回复他的判断语录';
    const short='等 Jimmy 回复他的判断语录';
    const first=saveGroupEvidence(sources,{messageId:'om_progress_a',openId:'ou_james',displayName:'James',text:long,occurredAt:'2026-09-13T01:00:00Z'});
    const second=saveGroupEvidence(sources,{messageId:'om_progress_b',openId:'ou_james',displayName:'James',text:short,occurredAt:'2026-09-13T08:00:00Z'});
    repository.savePerspective({topicId:topic.id,kind:'james_view',expectedVersion:0,statement:long,confidence:1,evidenceIds:[first],decisionKey:'progress',speechAct:'view',observedAt:new Date('2026-09-13T01:00:00Z')});
    repository.savePerspective({topicId:duplicate.id,kind:'james_view',expectedVersion:0,statement:short,confidence:1,evidenceIds:[second],decisionKey:'next',speechAct:'view',observedAt:new Date('2026-09-13T08:00:00Z')});

    const result=repository.listCanonicalPerspectives(topic.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.statement).toBe(long);
    expect(new Set(result[0]!.evidenceIds)).toEqual(new Set([first,second]));
  });
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
