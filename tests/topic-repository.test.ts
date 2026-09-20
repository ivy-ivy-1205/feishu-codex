import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import {
  TopicRepository,
  TopicVersionConflictError
} from '../src/repositories/topic-repository.js';

function createHarness() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  return { database, repository: new TopicRepository(database.client) };
}

function insertEvidence(
  database: ReturnType<typeof createSqliteDatabase>,
  suffix: string
): { sourceId: string; evidenceId: string } {
  const sourceId = `ctxsrc_${suffix}`;
  const evidenceId = `ctxev_${suffix}`;
  database.client.prepare(`
    INSERT INTO context_sources (
      id, source_system, source_type, external_id, logical_key, source_version,
      occurred_at, authors_json, locator_uri, content_format, content_text,
      metadata_json, content_hash, availability_status, captured_at
    ) VALUES (?, 'fixture', 'group_message', ?, ?, 1, ?, '[]', NULL,
      'text/plain', ?, '{}', ?, 'available', ?)
  `).run(
    sourceId,
    `message-${suffix}`,
    `fixture:message:${suffix}`,
    '2026-09-01T00:00:00.000Z',
    `evidence ${suffix}`,
    suffix.padEnd(64, '0').slice(0, 64),
    '2026-09-01T00:01:00.000Z'
  );
  database.client.prepare(`
    INSERT INTO context_evidence (
      id, source_id, source_version, excerpt, locator_json, excerpt_hash,
      evidence_level, captured_at
    ) VALUES (?, ?, 1, ?, ?, ?, 'primary_statement', ?)
  `).run(
    evidenceId,
    sourceId,
    `evidence ${suffix}`,
    JSON.stringify({ kind: 'group_message', suffix }),
    suffix.padStart(64, 'f').slice(0, 64),
    '2026-09-01T00:01:00.000Z'
  );
  return { sourceId, evidenceId };
}

describe('TopicRepository', () => {
  it('appends immutable versions and moves only the current pointer', () => {
    const { database, repository } = createHarness();
    const evidence = insertEvidence(database, '1');
    const createdAt = new Date('2026-09-01T01:00:00.000Z');
    const changedAt = new Date('2026-09-02T01:00:00.000Z');

    const topic = repository.createTopic({
      displayName: '买家知识库',
      stage: 'idea',
      createdAt
    });
    repository.appendVersion({
      topicId: topic.id,
      expectedVersion: 1,
      displayName: '房地产销售知识库',
      stage: 'exploring',
      outcome: null,
      rationale: '第二轮讨论扩大了范围',
      evidenceIds: [evidence.evidenceId],
      changedAt
    });

    expect(repository.listVersions(topic.id)).toEqual([
      expect.objectContaining({
        topicId: topic.id,
        versionNumber: 1,
        displayName: '买家知识库',
        stage: 'idea',
        evidenceIds: []
      }),
      expect.objectContaining({
        topicId: topic.id,
        versionNumber: 2,
        displayName: '房地产销售知识库',
        stage: 'exploring',
        rationale: '第二轮讨论扩大了范围',
        evidenceIds: [evidence.evidenceId]
      })
    ]);
    expect(repository.listCurrentTopics()).toEqual([
      expect.objectContaining({
        id: topic.id,
        currentVersion: 2,
        displayName: '房地产销售知识库',
        stage: 'exploring'
      })
    ]);
  });

  it('throws TOPIC_VERSION_CONFLICT and rolls back a stale append', () => {
    const { repository } = createHarness();
    const topic = repository.createTopic({
      displayName: '买家知识库',
      stage: 'idea',
      createdAt: new Date('2026-09-01T01:00:00.000Z')
    });
    repository.appendVersion({
      topicId: topic.id,
      expectedVersion: 1,
      displayName: '买家知识库',
      stage: 'exploring',
      outcome: null,
      rationale: '有了第二轮讨论',
      evidenceIds: [],
      changedAt: new Date('2026-09-02T01:00:00.000Z')
    });

    expect(() => repository.appendVersion({
      topicId: topic.id,
      expectedVersion: 1,
      displayName: '过期写入',
      stage: 'active_project',
      outcome: '不应保存',
      rationale: '基于旧版本',
      evidenceIds: [],
      changedAt: new Date('2026-09-03T01:00:00.000Z')
    })).toThrowError(expect.objectContaining({
      code: 'TOPIC_VERSION_CONFLICT',
      name: TopicVersionConflictError.name
    }));
    expect(repository.listVersions(topic.id).map((version) => version.versionNumber))
      .toEqual([1, 2]);
    expect(repository.listCurrentTopics()[0]?.currentVersion).toBe(2);
  });

  it('keeps topics, versions, source links and evidence after merge and split relations', () => {
    const { database, repository } = createHarness();
    const firstEvidence = insertEvidence(database, 'merge');
    const secondEvidence = insertEvidence(database, 'split');
    const createdAt = new Date('2026-09-01T01:00:00.000Z');
    const first = repository.createTopic({ displayName: '买家知识库', stage: 'idea', createdAt });
    const second = repository.createTopic({ displayName: '销售知识库', stage: 'exploring', createdAt });

    repository.addSource({
      topicId: first.id,
      sourceId: firstEvidence.sourceId,
      evidenceId: firstEvidence.evidenceId,
      addedAt: createdAt
    });
    repository.addSource({
      topicId: second.id,
      sourceId: secondEvidence.sourceId,
      evidenceId: secondEvidence.evidenceId,
      addedAt: createdAt
    });
    const merge = repository.addRelation({
      fromTopicId: first.id,
      toTopicId: second.id,
      relationType: 'same_as',
      rationale: 'Ivy 确认是同一方向',
      createdAt
    });
    const replayedMerge = repository.addRelation({
      fromTopicId: second.id,
      toTopicId: first.id,
      relationType: 'same_as',
      rationale: '反向重放不应重复',
      createdAt
    });
    repository.addRelation({
      fromTopicId: second.id,
      toTopicId: first.id,
      relationType: 'split_from',
      rationale: '后续拆成独立边界',
      createdAt: new Date('2026-09-03T01:00:00.000Z')
    });

    expect(replayedMerge.id).toBe(merge.id);
    expect(repository.listCurrentTopics()).toHaveLength(2);
    expect(repository.listVersions(first.id)).toHaveLength(1);
    expect(repository.listVersions(second.id)).toHaveLength(1);
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_topic_sources').get())
      .toEqual({ count: 2 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get())
      .toEqual({ count: 2 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_topic_relations').get())
      .toEqual({ count: 2 });
  });
});
