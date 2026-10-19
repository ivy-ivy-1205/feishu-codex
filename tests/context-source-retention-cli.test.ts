import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { runContextSourceRetentionCli } from '../src/cli/context-source-retention.js';

function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const repository = new ContextSourceRepository(database.client);
  const source = repository.saveSource({
    sourceSystem: 'feishu', sourceType: 'group_message', externalId: 'om_due',
    logicalKey: 'feishu:chat:approved:message:om_due', occurredAt: '2026-09-01T00:00:00.000Z',
    authors: [], locatorUri: null, contentFormat: 'text/plain', contentText: 'SECRET BODY',
    metadata: { chatId: 'approved' }, availabilityStatus: 'available',
    capturedAt: new Date('2026-09-01T00:00:00.000Z'),
    rawTextExpiresAt: new Date('2026-09-20T00:00:00.000Z')
  }).source;
  return { database, repository, source };
}

describe('context source retention CLI', () => {
  it('produces an exact content-free preview before execution', () => {
    const { repository, source } = setup();
    const lines: string[] = [];
    runContextSourceRetentionCli([
      '--preview', '--as-of', '2026-09-21T00:00:00.000Z', '--source-id', source.id
    ], { repository, now: () => new Date('2026-09-21T00:01:00.000Z'), write: (line) => lines.push(line) });

    expect(JSON.parse(lines.join(''))).toEqual({
      mode: 'preview', requested: 1, eligible: 1,
      sources: [{ id: source.id, sourceType: 'group_message', rawTextExpiresAt: '2026-09-20T00:00:00.000Z' }]
    });
    expect(lines.join('')).not.toContain('SECRET BODY');
    expect(repository.getSource(source.id)?.contentState).toBe('cleartext');
  });

  it('rejects an incomplete preview and executes only an exact due set', () => {
    const { repository, source } = setup();
    expect(() => runContextSourceRetentionCli([
      '--preview', '--as-of', '2026-09-19T00:00:00.000Z', '--source-id', source.id
    ], { repository, now: () => new Date('2026-09-21T00:01:00.000Z'), write: () => undefined }))
      .toThrow('CONTEXT_SOURCE_RETENTION_PREVIEW_MISMATCH');

    const lines: string[] = [];
    runContextSourceRetentionCli([
      '--execute', '--as-of', '2026-09-21T00:00:00.000Z', '--source-id', source.id
    ], { repository, now: () => new Date('2026-09-21T00:01:00.000Z'), write: (line) => lines.push(line) });
    expect(JSON.parse(lines.join(''))).toEqual({ mode: 'execute', requested: 1, redacted: 1 });
    expect(repository.getSource(source.id)?.contentState).toBe('redacted');
  });

  it('requires one mode, a valid as-of instant and a unique nonempty source set', () => {
    const { repository, source } = setup();
    const dependencies = { repository, now: () => new Date(), write: () => undefined };
    for (const args of [
      [],
      ['--preview', '--execute', '--as-of', '2026-09-21T00:00:00.000Z', '--source-id', source.id],
      ['--preview', '--as-of', 'bad', '--source-id', source.id],
      ['--preview', '--as-of', '2026-09-21T00:00:00.000Z'],
      ['--preview', '--as-of', '2026-09-21T00:00:00.000Z', '--source-id', source.id, '--source-id', source.id]
    ]) expect(() => runContextSourceRetentionCli(args, dependencies)).toThrow();
  });
});
