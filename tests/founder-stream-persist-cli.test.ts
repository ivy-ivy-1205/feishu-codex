import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { assertFounderStreamPersistSchema } from '../src/cli/persist-founder-stream.js';

describe('bounded founder stream persist CLI', () => {
  it('accepts the existing retention schema without creating unrelated tables', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    for (const table of ['founder_perspective_observations', 'founder_feedback_corrections',
      'alignment_issues', 'founder_stream_events', 'context_topics', 'context_topic_versions',
      'context_topic_sources', 'context_topic_relations', 'founder_identities', 'topic_perspectives',
      'topic_perspective_versions']) {
      database.client.exec(`DROP TABLE ${table}`);
    }
    const before = database.client.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();

    expect(() => assertFounderStreamPersistSchema(database.client)).not.toThrow();
    expect(database.client.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all()).toEqual(before);
    database.close();
  });

  it('fails closed when retention columns or the job schema are incomplete', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE context_sources (id TEXT PRIMARY KEY);
      CREATE TABLE batch_jobs (id TEXT PRIMARY KEY);
    `);
    expect(() => assertFounderStreamPersistSchema(database.client))
      .toThrow('FOUNDER_STREAM_PERSIST_SCHEMA_INVALID');
    database.close();
  });
});
