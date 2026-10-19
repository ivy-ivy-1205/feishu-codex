import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

interface ConcurrentAppendResult {
  ok: boolean;
  versionNumber?: number;
  name?: string;
  code?: string;
  message?: string;
}

function spawnConcurrentAppend(
  databasePath: string,
  topicId: string,
  label: string
): { ready: Promise<void>; start(): void; result: Promise<ConcurrentAppendResult> } {
  const clientUrl = pathToFileURL(resolve('src/db/client.ts')).href;
  const repositoryUrl = pathToFileURL(resolve('src/repositories/topic-repository.ts')).href;
  const script = `
    import { createSqliteDatabase } from ${JSON.stringify(clientUrl)};
    import { TopicRepository } from ${JSON.stringify(repositoryUrl)};
    const database = createSqliteDatabase(${JSON.stringify(databasePath)});
    database.client.pragma('busy_timeout = 2000');
    database.client.function('topic_test_pause', () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      return 0;
    });
    process.send?.('ready');
    process.once('message', (message) => {
      if (message !== 'start') return;
      let result;
      try {
        const version = new TopicRepository(database.client).appendVersion({
          topicId: ${JSON.stringify(topicId)},
          expectedVersion: 1,
          displayName: ${JSON.stringify(`并发写入 ${label}`)},
          stage: 'exploring',
          outcome: null,
          rationale: ${JSON.stringify(`并发竞争 ${label}`)},
          evidenceIds: [],
          changedAt: new Date(${JSON.stringify(`2026-09-02T01:00:0${label === 'A' ? '1' : '2'}.000Z`)})
        });
        result = { ok: true, versionNumber: version.versionNumber };
      } catch (error) {
        result = {
          ok: false,
          name: error instanceof Error ? error.name : typeof error,
          code: error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : undefined,
          message: error instanceof Error ? error.message : String(error)
        };
      } finally {
        database.close();
      }
      process.send?.({ type: 'result', value: result }, () => process.disconnect());
    });
  `;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', script
  ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  return concurrentAppendHandle(child);
}

function concurrentAppendHandle(
  child: ChildProcess
): { ready: Promise<void>; start(): void; result: Promise<ConcurrentAppendResult> } {
  let readyResolve!: () => void;
  let resultResolve!: (result: ConcurrentAppendResult) => void;
  let resultReject!: (error: Error) => void;
  let stderr = '';
  let settled = false;
  const ready = new Promise<void>((resolveReady) => { readyResolve = resolveReady; });
  const result = new Promise<ConcurrentAppendResult>((resolveResult, rejectResult) => {
    resultResolve = resolveResult;
    resultReject = rejectResult;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.on('message', (message: unknown) => {
    if (message === 'ready') {
      readyResolve();
      return;
    }
    if (message && typeof message === 'object' && 'type' in message &&
      message.type === 'result' && 'value' in message) {
      settled = true;
      resultResolve(message.value as ConcurrentAppendResult);
    }
  });
  child.on('error', (error) => {
    settled = true;
    resultReject(error);
  });
  child.on('exit', (code) => {
    if (!settled) resultReject(new Error(`concurrent append exited ${code}: ${stderr}`));
  });
  return {
    ready,
    start: () => child.send('start'),
    result
  };
}

describe('TopicRepository', () => {
  it('collapses only human-confirmed same_as components while preserving part_of children', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const topics = new TopicRepository(database.client);
    const first = topics.createTopic({ displayName: 'AI Native 房产业务', stage: 'active_project',
      evidenceIds: [insertEvidence(database, 'canonical').evidenceId], createdAt: new Date('2026-09-01T00:00:00.000Z') });
    const duplicate = topics.createTopic({ displayName: 'AI Native 房产服务', stage: 'project_candidate',
      evidenceIds: [insertEvidence(database, 'duplicate').evidenceId], createdAt: new Date('2026-09-02T00:00:00.000Z') });
    const child = topics.createTopic({ displayName: 'Smart Listing', stage: 'active_project',
      evidenceIds: [insertEvidence(database, 'child').evidenceId], createdAt: new Date('2026-09-03T00:00:00.000Z') });
    topics.addRelation({ fromTopicId: first.id, toTopicId: duplicate.id, relationType: 'same_as',
      rationale: 'Ivy confirmed same project', createdAt: new Date('2026-09-04T00:00:00.000Z') });
    topics.addRelation({ fromTopicId: child.id, toTopicId: first.id, relationType: 'part_of',
      rationale: 'Ivy confirmed child project', createdAt: new Date('2026-09-04T00:00:00.000Z') });

    expect(topics.listCurrentTopics()).toHaveLength(3);
    expect(topics.listCanonicalTopics()).toEqual([
      expect.objectContaining({ id: first.id, displayName: 'AI Native 房产业务',
        evidenceIds: expect.arrayContaining([...first.evidenceIds, ...duplicate.evidenceIds]) }),
      expect.objectContaining({ id: child.id, displayName: 'Smart Listing' })
    ]);
    database.close();
  });
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

  it('returns TOPIC_VERSION_CONFLICT instead of a SQLite lock error for a real two-connection race', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'topic-version-race-'));
    const databasePath = join(directory, 'topics.sqlite');
    const database = createSqliteDatabase(databasePath);
    try {
      database.client.pragma('journal_mode = WAL');
      migrateDatabase(database.client);
      const repository = new TopicRepository(database.client);
      const topic = repository.createTopic({
        displayName: '买家知识库',
        stage: 'idea',
        createdAt: new Date('2026-09-01T01:00:00.000Z')
      });
      database.client.exec(`
        CREATE TRIGGER pause_topic_version_two
        BEFORE INSERT ON context_topic_versions
        WHEN NEW.version_number = 2
        BEGIN
          SELECT topic_test_pause();
        END
      `);
      database.close();

      const first = spawnConcurrentAppend(databasePath, topic.id, 'A');
      const second = spawnConcurrentAppend(databasePath, topic.id, 'B');
      await Promise.all([first.ready, second.ready]);
      first.start();
      second.start();
      const results = await Promise.all([first.result, second.result]);

      expect(results.filter((result) => result.ok)).toEqual([
        expect.objectContaining({ ok: true, versionNumber: 2 })
      ]);
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({
          ok: false,
          name: TopicVersionConflictError.name,
          code: 'TOPIC_VERSION_CONFLICT',
          message: 'TOPIC_VERSION_CONFLICT'
        })
      ]);

      const verification = createSqliteDatabase(databasePath);
      expect(new TopicRepository(verification.client).listVersions(topic.id)
        .map((version) => version.versionNumber)).toEqual([1, 2]);
      verification.close();
    } finally {
      if (database.client.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

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
