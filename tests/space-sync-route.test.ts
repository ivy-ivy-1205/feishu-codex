import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { computeSpaceSyncSignature } from '../src/services/space-sync-signature.js';

const secret = 'route-test-secret';

function buildTestApp() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  const spaceSyncRepository = new SpaceSyncRepository(database.client);
  const contextSourceRepository = new ContextSourceRepository(database.client);
  spaceSyncRepository.createBinding({
    id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual',
    createdAt: new Date('2026-10-19T00:00:00.000Z')
  });

  const app = buildApp({
    readiness: () => ({ status: 'ok', checks: {} }) as never,
    verificationToken: 'verify', encryptKey: 'encrypt-key',
    ingestMinute: () => ({ status: 'ignored' }) as never,
    routeReply: () => ({ kind: 'clarify', reason: 'missing_reply_context' }) as never,
    logger: false,
    spaceSyncIngest: {
      secret, signatureWindowSeconds: 300, maxBodyBytes: 2_000_000,
      ingestion: { client: database.client, spaceSyncRepository, contextSourceRepository,
        limits: { maxBlocks: 500, maxComments: 2_000 } }
    }
  });
  return { app, database, contextSourceRepository };
}

function envelopeBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, syncId: 'sync_1', projectKey: 'smart_listing', trigger: 'manual',
    capturedAt: '2026-10-19T00:00:00.000Z',
    page: {
      pageId: 'page_1', spaceId: null, url: 'https://chatgpt.com/space/page_1',
      title: 'Smart Listing 总览', sequence: 1, updatedAt: '2026-10-18T10:00:00.000Z',
      blocks: [{ id: 'block_1', hash: 'a'.repeat(64), markdown: '当前阶段：试点' }]
    },
    comments: [],
    coverage: { pageComplete: true, commentsComplete: true, nextCursor: null, gaps: [] },
    ...overrides
  };
}

function signedHeaders(body: unknown, overrides: Partial<{ timestamp: string; syncId: string; secretOverride: string }> = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1_000));
  const syncId = overrides.syncId ?? (body as { syncId: string }).syncId;
  const signature = computeSpaceSyncSignature({
    timestamp, syncId, rawBody, secret: overrides.secretOverride ?? secret
  });
  return {
    'content-type': 'application/json',
    'x-space-sync-timestamp': timestamp,
    'x-space-sync-sync-id': syncId,
    'x-space-sync-signature': signature
  };
}

describe('POST /internal/space-sync/v1/ingest', () => {
  it('accepts a correctly signed, registered envelope and reports what was written', async () => {
    const { app } = buildTestApp();
    const body = envelopeBody();
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body), payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'accepted', replay: false,
      run: { pageSourceCreated: true, commentSourcesCreated: 0 } });
  });

  it('rejects a request with no signature headers', async () => {
    const { app } = buildTestApp();
    const body = envelopeBody();
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'space_sync_missing_signature_headers' });
  });

  it('rejects a request signed with the wrong secret', async () => {
    const { app } = buildTestApp();
    const body = envelopeBody();
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body, { secretOverride: 'wrong-secret' }), payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'space_sync_signature_invalid' });
  });

  it('rejects a stale timestamp outside the signature window', async () => {
    const { app } = buildTestApp();
    const body = envelopeBody();
    const staleTimestamp = String(Math.floor(Date.now() / 1_000) - 3_600);
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body, { timestamp: staleTimestamp }), payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'space_sync_timestamp_expired' });
  });

  it('rejects a body whose embedded syncId does not match the signed header', async () => {
    const { app } = buildTestApp();
    const body = envelopeBody();
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const headerSyncId = 'sync_other';
    const signature = computeSpaceSyncSignature({ timestamp, syncId: headerSyncId, rawBody, secret });
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: { 'content-type': 'application/json', 'x-space-sync-timestamp': timestamp,
        'x-space-sync-sync-id': headerSyncId, 'x-space-sync-signature': signature },
      payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'space_sync_sync_id_mismatch' });
  });

  it('rejects an envelope for an unregistered page with 400 and does not write anything', async () => {
    const { app, contextSourceRepository } = buildTestApp();
    const body = envelopeBody({ page: { ...envelopeBody().page, pageId: 'page_unregistered' } });
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body), payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'space_sync_unregistered_page' });
    expect(contextSourceRepository.listSources()).toHaveLength(0);
  });

  it('replays an identical resubmission idempotently with HTTP 200', async () => {
    const { app } = buildTestApp();
    const body = envelopeBody();
    await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body), payload: JSON.stringify(body)
    });
    const replay = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body), payload: JSON.stringify(body)
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replay: true });
  });

  it('rejects a structurally invalid envelope with 400 before touching the database', async () => {
    const { app, contextSourceRepository } = buildTestApp();
    const body = { ...envelopeBody(), schemaVersion: 2 };
    const response = await app.inject({
      method: 'POST', url: '/internal/space-sync/v1/ingest',
      headers: signedHeaders(body), payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'space_sync_invalid_envelope' });
    expect(contextSourceRepository.listSources()).toHaveLength(0);
  });
});
