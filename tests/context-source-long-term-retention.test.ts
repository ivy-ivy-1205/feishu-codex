import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';

const capturedAt = new Date('2026-09-21T17:57:00.000Z');

function save(repository: ContextSourceRepository, externalId: string) {
  return repository.saveSource({
    sourceSystem: 'feishu', sourceType: 'group_message', externalId, logicalKey: `feishu:chat:approved:message:${externalId}`,
    occurredAt: '2026-09-01T00:00:00.000Z', authors: [{ openId: 'ou_ivy' }], locatorUri: null, contentFormat: 'text/plain',
    contentText: `private ${externalId}`, metadata: { chatId: 'approved', messageId: externalId }, availabilityStatus: 'available',
    capturedAt, rawTextExpiresAt: new Date('2026-12-20T17:57:00.000Z')
  }).source;
}

describe('long-term raw-text retention (Ivy, 2026-10-20)', () => {
  it('clears the 90-day expiry older code put on cleartext sources, keeps their text, and leaves redacted rows alone', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new ContextSourceRepository(database.client);
    const kept = save(repository, 'kept'), redacted = save(repository, 'redacted');
    database.client.prepare(`UPDATE context_sources SET content_state='redacted', content_text='[REDACTED:RETENTION_EXPIRED]',
      redacted_at=? WHERE id=?`).run('2026-12-21T00:00:00.000Z', redacted.id);

    migrateDatabase(database.client);

    expect(repository.getSource(kept.id)).toMatchObject({ rawTextExpiresAt: null, contentState: 'cleartext', contentText: 'private kept' });
    expect(repository.getSource(redacted.id)).toMatchObject({ rawTextExpiresAt: '2026-12-20T17:57:00.000Z', contentState: 'redacted' });
    expect(repository.previewExpiredRawText({ sourceIds: [kept.id], asOf: new Date('2027-01-01T00:00:00.000Z') })).toEqual([]);
    migrateDatabase(database.client);
    expect(repository.getSource(kept.id)).toMatchObject({ rawTextExpiresAt: null, contentText: 'private kept' });
    database.close();
  });
});
