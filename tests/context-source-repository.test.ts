import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { canonicalJson, sha256 } from '../src/services/canonical-json.js';
import { captureMinuteTranscriptSource } from '../src/services/context-source-capture.js';

const sourceInput = {
  sourceSystem: 'fixture',
  sourceType: 'transcript',
  externalId: 'minute-1',
  logicalKey: 'fixture:minute-1:transcript',
  occurredAt: '2026-08-03T01:00:00.000Z',
  authors: [{ name: 'Ivy' }],
  locatorUri: null,
  contentFormat: 'text/plain',
  contentText: 'Ivy [0-1000]: Phase 1E 已进入实现。',
  metadata: { title: 'Phase 1E', segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1000, text: 'Phase 1E 已进入实现。' }] },
  availabilityStatus: 'available' as const,
  capturedAt: new Date('2026-08-03T02:00:00.000Z')
};

describe('ContextSourceRepository', () => {
  it('deduplicates immutable snapshots and versions changed content', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);

    const first = repository.saveSource(sourceInput);
    const replay = repository.saveSource(sourceInput);
    const changed = repository.saveSource({ ...sourceInput, contentText: `${sourceInput.contentText}\nAmy [1001-2000]: 收到。` });

    expect(first).toMatchObject({ created: true, source: { sourceVersion: 1 } });
    expect(replay).toMatchObject({ created: false, source: { id: first.source.id, sourceVersion: 1 } });
    expect(changed).toMatchObject({ created: true, source: { sourceVersion: 2, logicalKey: sourceInput.logicalKey } });
    expect(repository.listSources()).toHaveLength(2);
  });

  it('binds evidence to an immutable source version and preserves it when availability changes', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const saved = repository.saveSource(sourceInput).source;
    const evidenceInput = {
      sourceId: saved.id,
      excerpt: 'Phase 1E 已进入实现。',
      locator: { segmentOrdinal: 0, sourceVersion: 1, contentHash: saved.contentHash,
        speakerName: 'Ivy', startMs: 0, endMs: 1000 },
      evidenceLevel: 'primary_statement' as const,
      capturedAt: sourceInput.capturedAt
    };

    const evidence = repository.saveEvidence(evidenceInput);
    const replay = repository.saveEvidence(evidenceInput);
    repository.markSourceAvailability(saved.id, 'deleted');

    expect(replay).toMatchObject({ created: false, evidence: { id: evidence.evidence.id } });
    expect(repository.getEvidence(evidence.evidence.id)).toMatchObject({
      sourceId: saved.id,
      sourceVersion: 1,
      excerpt: evidenceInput.excerpt
    });
    expect(repository.getSource(saved.id)?.availabilityStatus).toBe('deleted');
  });

  it('reuses legacy minute evidence stored before discriminated locators', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const source = repository.saveSource(sourceInput).source;
    const excerpt = 'Phase 1E 已进入实现。';
    const legacyLocator = {
      segmentOrdinal: 0,
      sourceVersion: 1,
      contentHash: source.contentHash,
      speakerName: 'Ivy',
      startMs: 0,
      endMs: 1000
    };
    database.client.prepare(`
      INSERT INTO context_evidence (
        id, source_id, source_version, excerpt, locator_json, excerpt_hash,
        evidence_level, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ctxev_legacy', source.id, 1, excerpt, canonicalJson(legacyLocator), sha256(excerpt),
      'primary_statement', sourceInput.capturedAt.toISOString());

    const replay = repository.saveEvidence({
      sourceId: source.id,
      excerpt,
      locator: legacyLocator,
      evidenceLevel: 'primary_statement',
      capturedAt: sourceInput.capturedAt
    });

    expect(replay).toMatchObject({ created: false, evidence: { id: 'ctxev_legacy' } });
    expect(replay.evidence.locator).toMatchObject({ kind: 'minute_segment', segmentOrdinal: 0 });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get()).toEqual({ count: 1 });
  });

  it('persists evidence against real multiline segment boundaries and continuation lines', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const captured = captureMinuteTranscriptSource({
      minuteId: 'minute-multiline', title: '多行 segment 回归',
      startedAt: '2026-08-03T01:00:00.000Z', endedAt: '2026-08-03T02:00:00.000Z',
      transcript: [
        { speakerName: 'James', startMs: 0, endMs: 1, text: '第一行\n第二行' },
        { speakerName: 'Ivy', startMs: 1, endMs: 2, text: '后续决定' }
      ]
    }, sourceInput.capturedAt);
    const source = repository.saveSource(captured.source).source;

    const laterSegment = repository.saveEvidence({
      sourceId: source.id, excerpt: '后续决定', evidenceLevel: 'primary_statement',
      locator: { segmentOrdinal: 1, sourceVersion: source.sourceVersion, contentHash: source.contentHash,
        speakerName: 'Ivy', startMs: 1, endMs: 2 }, capturedAt: sourceInput.capturedAt
    });
    const continuationLine = repository.saveEvidence({
      sourceId: source.id, excerpt: '第二行', evidenceLevel: 'primary_statement',
      locator: { segmentOrdinal: 0, sourceVersion: source.sourceVersion, contentHash: source.contentHash,
        speakerName: 'James', startMs: 0, endMs: 1 }, capturedAt: sourceInput.capturedAt
    });

    expect(laterSegment.evidence.locator).toMatchObject({ kind: 'minute_segment', segmentOrdinal: 1 });
    expect(continuationLine.evidence.excerpt).toBe('第二行');
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get()).toEqual({ count: 2 });
  });

  it('binds group-message evidence to stable message and thread identity', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const capturedAt = new Date('2026-09-01T00:01:00.000Z');
    const source = repository.saveSource({
      sourceSystem: 'feishu',
      sourceType: 'group_message',
      externalId: 'om_1',
      logicalKey: 'feishu:chat:oc_a84d5b6ca478220d0a37964b50776edb:message:om_1',
      occurredAt: '2026-09-01T00:00:00.000Z',
      authors: [{ openId: 'ou_ivy', displayName: 'Ivy' }],
      locatorUri: 'https://applink.feishu.cn/client/message/open?chatId=oc_a84d5b6ca478220d0a37964b50776edb&messageId=om_1',
      contentFormat: 'text/plain',
      contentText: '先做页面预览',
      metadata: {
        chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
        messageId: 'om_1',
        threadId: 'omt_1',
        rootId: 'om_root',
        messageType: 'text'
      },
      availabilityStatus: 'available',
      capturedAt
    }).source;
    const locator = {
      kind: 'group_message' as const,
      sourceVersion: 1,
      contentHash: source.contentHash,
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messageId: 'om_1',
      threadId: 'omt_1',
      authorOpenId: 'ou_ivy',
      occurredAt: '2026-09-01T00:00:00.000Z'
    };

    expect(repository.saveEvidence({ sourceId: source.id, excerpt: '先做页面预览', locator,
      evidenceLevel: 'primary_statement', capturedAt })).toMatchObject({
      created: true,
      evidence: { locator }
    });
  });

  it.each([
    ['ordinal', { segmentOrdinal: 2 }],
    ['speaker', { speakerName: 'Amy' }],
    ['time range', { startMs: 2 }],
    ['source version', { sourceVersion: 2 }],
    ['content hash', { contentHash: 'f'.repeat(64) }]
  ])('rejects a mismatched %s without persisting evidence', (_label, override) => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const captured = captureMinuteTranscriptSource({
      minuteId: 'minute-invalid', title: '非法 locator 回归',
      startedAt: '2026-08-03T01:00:00.000Z', endedAt: '2026-08-03T02:00:00.000Z',
      transcript: [
        { speakerName: 'James', startMs: 0, endMs: 1, text: '第一行\n第二行' },
        { speakerName: 'Ivy', startMs: 1, endMs: 2, text: '后续决定' }
      ]
    }, sourceInput.capturedAt);
    const source = repository.saveSource(captured.source).source;
    const locator = { segmentOrdinal: 1, sourceVersion: source.sourceVersion, contentHash: source.contentHash,
      speakerName: 'Ivy', startMs: 1, endMs: 2, ...override };

    expect(() => repository.saveEvidence({ sourceId: source.id, excerpt: '后续决定',
      locator, evidenceLevel: 'primary_statement', capturedAt: sourceInput.capturedAt })).toThrow();
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get()).toEqual({ count: 0 });
  });

  it('reuses an identical extraction run and source set', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const source = repository.saveSource(sourceInput).source;
    const input = {
      sources: [{ id: source.id, contentHash: source.contentHash }],
      extractorName: 'codex',
      extractorVersion: 'phase1e-v1',
      promptVersion: 'context-v1',
      startedAt: sourceInput.capturedAt
    };

    expect(repository.beginExtractionRun(input).created).toBe(true);
    expect(repository.beginExtractionRun(input).created).toBe(false);
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_extraction_run_sources').get())
      .toEqual({ count: 1 });
  });
});
