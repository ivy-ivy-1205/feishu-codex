import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { buildFounderStreamInput } from '../src/services/founder-stream-worker.js';
import { sha256 } from '../src/services/canonical-json.js';

const capturedAt = new Date('2026-09-21T00:00:00.000Z');
const expiresAt = new Date('2026-12-20T00:00:00.000Z');

function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  return { database, repository: new ContextSourceRepository(database.client) };
}

function saveGroupSource(repository: ContextSourceRepository, externalId: string, expiry = expiresAt) {
  return repository.saveSource({
    sourceSystem: 'feishu', sourceType: 'group_message', externalId,
    logicalKey: `feishu:chat:approved:message:${externalId}`,
    occurredAt: '2026-09-01T00:00:00.000Z', authors: [{ openId: 'ou_ivy' }],
    locatorUri: null, contentFormat: 'text/plain', contentText: `private ${externalId}`,
    metadata: { chatId: 'approved', messageId: externalId }, availabilityStatus: 'available',
    capturedAt, rawTextExpiresAt: expiry
  }).source;
}

describe('context source raw-text retention', () => {
  it('previews only due cleartext sources without returning their content', () => {
    const { repository } = setup();
    const due = saveGroupSource(repository, 'due', new Date('2026-09-20T00:00:00.000Z'));
    saveGroupSource(repository, 'future', new Date('2026-12-20T00:00:00.000Z'));

    expect(repository.previewExpiredRawText({
      sourceIds: [due.id], asOf: new Date('2026-09-21T00:00:00.000Z')
    })).toEqual([{ id: due.id, sourceType: 'group_message', rawTextExpiresAt: '2026-09-20T00:00:00.000Z' }]);
  });

  it('redacts an exact due source set while preserving identity and existing evidence', () => {
    const { database, repository } = setup();
    const source = saveGroupSource(repository, 'due', new Date('2026-09-20T00:00:00.000Z'));
    const evidence = repository.saveEvidence({
      sourceId: source.id, excerpt: 'private due',
      locator: { kind: 'group_message', sourceVersion: source.sourceVersion, contentHash: source.contentHash,
        chatId: 'approved', messageId: 'due', threadId: null, authorOpenId: 'ou_ivy',
        occurredAt: '2026-09-01T00:00:00.000Z' },
      evidenceLevel: 'primary_statement', capturedAt
    }).evidence;

    const result = repository.redactExpiredRawText({
      sourceIds: [source.id], asOf: new Date('2026-09-21T00:00:00.000Z'),
      redactedAt: new Date('2026-09-21T00:01:00.000Z')
    });

    expect(result).toEqual({ redactedSourceIds: [source.id] });
    expect(repository.getSource(source.id)).toMatchObject({
      id: source.id,
      contentText: '[REDACTED:RETENTION_EXPIRED]',
      contentHash: source.contentHash,
      contentState: 'redacted',
      rawTextExpiresAt: '2026-09-20T00:00:00.000Z',
      redactedAt: '2026-09-21T00:01:00.000Z'
    });
    const redactedEvidence = repository.getEvidence(evidence.id);
    expect(redactedEvidence).toMatchObject({
      id: evidence.id,
      sourceId: source.id,
      excerpt: `[REDACTED:RETENTION_EXPIRED:${evidence.id}]`
    });
    expect(redactedEvidence?.excerptHash).toBe(sha256(redactedEvidence!.excerpt));
    expect(database.client.pragma('secure_delete', { simple: true })).toBe(1);
    expect(database.client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => repository.saveEvidence({
      sourceId: source.id, excerpt: 'private due', locator: evidence.locator,
      evidenceLevel: 'primary_statement', capturedAt
    })).toThrow('CONTEXT_SOURCE_RAW_TEXT_REDACTED');
    expect(() => repository.beginExtractionRun({
      sources: [{ id: source.id, contentHash: source.contentHash }], extractorName: 'codex',
      extractorVersion: 'v1', promptVersion: 'v1', startedAt: capturedAt
    })).toThrow('CONTEXT_SOURCE_RAW_TEXT_REDACTED');
    expect(() => buildFounderStreamInput(repository, new TopicRepository(database.client),
      [source.id], 'approved')).toThrow('FOUNDER_SOURCE_UNAVAILABLE');
  });

  it('rejects a mixed exact set atomically when any source is missing, not due or duplicated', () => {
    const { repository } = setup();
    const due = saveGroupSource(repository, 'due', new Date('2026-09-20T00:00:00.000Z'));
    const future = saveGroupSource(repository, 'future', new Date('2026-12-20T00:00:00.000Z'));
    const command = { asOf: new Date('2026-09-21T00:00:00.000Z'), redactedAt: new Date('2026-09-21T00:01:00.000Z') };

    expect(() => repository.redactExpiredRawText({ ...command, sourceIds: [due.id, future.id] }))
      .toThrow('CONTEXT_SOURCE_RETENTION_NOT_DUE');
    expect(repository.getSource(due.id)?.contentState).toBe('cleartext');
    expect(() => repository.redactExpiredRawText({ ...command, sourceIds: [due.id, 'missing'] }))
      .toThrow('CONTEXT_SOURCE_RETENTION_SOURCE_NOT_FOUND');
    expect(() => repository.redactExpiredRawText({ ...command, sourceIds: [due.id, due.id] }))
      .toThrow('CONTEXT_SOURCE_RETENTION_SOURCE_SET_INVALID');
    expect(repository.getSource(due.id)?.contentText).toBe('private due');
  });

  it('refuses to redact a source still owned by queued or processing work', () => {
    const { database, repository } = setup();
    const source = saveGroupSource(repository, 'active', new Date('2026-09-20T00:00:00.000Z'));
    new JobRepository(database.client).enqueueFounderStreamBatch({
      chatId: 'approved', since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z',
      sourceIds: [source.id], capturedAt
    });

    expect(() => repository.redactExpiredRawText({
      sourceIds: [source.id], asOf: new Date('2026-09-21T00:00:00.000Z'), redactedAt: capturedAt
    })).toThrow('CONTEXT_SOURCE_RETENTION_ACTIVE_USE');
    expect(repository.getSource(source.id)?.contentState).toBe('cleartext');

    database.client.prepare("UPDATE batch_jobs SET status = 'completed'").run();
    database.client.prepare(`INSERT INTO batch_jobs
      (id, type, stable_key, payload, status, created_at, updated_at)
      VALUES ('bad', 'analyze_founder_stream_batch', 'bad', '{', 'queued', ?, ?)`)
      .run(capturedAt.toISOString(), capturedAt.toISOString());
    expect(() => repository.redactExpiredRawText({
      sourceIds: [source.id], asOf: new Date('2026-09-21T00:00:00.000Z'), redactedAt: capturedAt
    })).toThrow('CONTEXT_SOURCE_RETENTION_ACTIVE_USE');
  });
});
