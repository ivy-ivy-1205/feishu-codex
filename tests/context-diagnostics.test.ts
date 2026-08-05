import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { registerContextDiagnosticsRoute } from '../src/routes/context-diagnostics.js';

describe('/diag/context', () => {
  it('returns aggregate lifecycle counts without source, evidence or identity content', async () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    database.client.prepare(`INSERT INTO context_sources (id, source_system, source_type, external_id, logical_key, source_version, occurred_at, authors_json, locator_uri, content_format, content_text, metadata_json, content_hash, availability_status, captured_at) VALUES ('s1','fixture','transcript','m1','m1',1,'2026-08-03','[]','secret-uri','text/plain','secret transcript','{}','h1','available','2026-08-03T01:00:00.000Z')`).run();
    const app = fastify(); registerContextDiagnosticsRoute(app, database.client);
    const response = await app.inject({ method: 'GET', url: '/diag/context' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      sources: { total: 1, latestCapturedAt: '2026-08-03T01:00:00.000Z' },
      extractionRuns: { processing: 0, completed: 0, failed: 0 },
      candidates: { pending: 0, approved: 0, rejected: 0, needsClarification: 0, conflict: 0 },
      records: { active: 0, disputed: 0, archived: 0 }
    });
    expect(response.body).not.toContain('secret transcript');
    expect(response.body).not.toContain('secret-uri');
  });
});
