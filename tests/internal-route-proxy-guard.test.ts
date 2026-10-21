import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSpaceSyncIngestDependencies } from '../src/composition/space-sync.js';
import type { AppConfig } from '../src/config.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';

const config: AppConfig['spaceSync'] = { ingestEnabled: true, analysisEnabled: false, workmapEnabled: false,
  hmacSecretFile: '/app/secrets/space-sync-hmac', signatureWindowSeconds: 300, staleAfterMinutes: 24 * 60,
  maxBlocks: 500, maxComments: 2_000, maxBodyBytes: 2_000_000 };
const ingestPath = '/internal/space-sync/v1/ingest';
const closers: Array<() => Promise<unknown> | void> = [];

function appWithIngest() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const spaceSyncIngest = createSpaceSyncIngestDependencies({ config, client: db.client, jobRepository: new JobRepository(db.client),
    readSecretFile: () => 'k'.repeat(48) })!;
  const app = buildApp({ readiness: () => ({ status: 'ok', checks: {} }) as never, verificationToken: 'verify', encryptKey: 'encrypt-key',
    ingestMinute: () => ({ status: 'ignored' }) as never, routeReply: () => ({ kind: 'clarify', reason: 'missing_reply_context' }) as never,
    logger: false, spaceSyncIngest });
  closers.push(() => app.close(), () => db.close());
  return app;
}

function post(app: ReturnType<typeof buildApp>, url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: '{}' });
}

afterEach(async () => { for (const close of closers.splice(0)) await close(); });

describe('internal routes are local-only (S2 nginx gate, 2026-10-21)', () => {
  it('answers a request relayed by nginx exactly as if the route did not exist', async () => {
    const app = appWithIngest();
    const missing = await post(app, '/internal/no-such-route');
    const relays: Array<Record<string, string>> = [{ 'x-forwarded-for': '203.0.113.7' }, { 'x-real-ip': '203.0.113.7' },
      { forwarded: 'for=203.0.113.7;proto=https' }];
    for (const headers of relays) {
      const relayed = await post(app, ingestPath, headers);
      expect(relayed.statusCode).toBe(404);
      expect(relayed.body).toBe(missing.body.replace('/internal/no-such-route', ingestPath));
    }
  });

  it('still guards an internal route reached through a percent-encoded path', async () => {
    const app = appWithIngest();
    const direct = await post(app, '/%69nternal/space-sync/v1/ingest');
    const relayed = await post(app, '/%69nternal/space-sync/v1/ingest', { 'x-forwarded-for': '203.0.113.7' });
    expect(relayed.statusCode).toBe(404);
    expect(direct.statusCode === 404 || direct.statusCode === 400).toBe(true);
  });

  it('keeps serving the same route to a direct local caller', async () => {
    const app = appWithIngest();
    expect((await post(app, ingestPath)).statusCode).toBe(400);
  });

  it('leaves the public Feishu and health routes untouched behind nginx', async () => {
    const app = appWithIngest();
    expect((await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '203.0.113.7' } })).statusCode).toBe(200);
    const webhook = await post(app, '/webhooks/feishu/events', { 'x-forwarded-for': '203.0.113.7' });
    expect(webhook.statusCode).not.toBe(404);
  });
});
