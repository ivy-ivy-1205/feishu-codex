import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSpaceSyncIngestDependencies, needsCodexAnalysis, spaceSyncWorkerOptions } from '../src/composition/space-sync.js';
import type { AppConfig } from '../src/config.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import { computeSpaceSyncSignature } from '../src/services/space-sync-signature.js';

const off: AppConfig['spaceSync'] = { ingestEnabled: false, analysisEnabled: false, workmapEnabled: false, hmacSecretFile: null,
  signatureWindowSeconds: 300, staleAfterMinutes: 24 * 60, maxBlocks: 500, maxComments: 2_000, maxBodyBytes: 2_000_000 };
const secret = 'k'.repeat(48);
const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  return { db, jobRepository: new JobRepository(db.client) };
}

function appWith(ingest: ReturnType<typeof createSpaceSyncIngestDependencies>) {
  return buildApp({ readiness: () => ({ status: 'ok', checks: {} }) as never, verificationToken: 'verify', encryptKey: 'encrypt-key',
    ingestMinute: () => ({ status: 'ignored' }) as never, routeReply: () => ({ kind: 'clarify', reason: 'missing_reply_context' }) as never,
    logger: false, ...(ingest ? { spaceSyncIngest: ingest } : {}) });
}

describe('Space sync wiring at server start', () => {
  it('changes nothing while every Space flag is off: no route, no secret read, no Space analysis', async () => {
    const h = setup(); let reads = 0;
    expect(createSpaceSyncIngestDependencies({ config: off, client: h.db.client, jobRepository: h.jobRepository,
      readSecretFile: () => { reads += 1; return secret; } })).toBeUndefined();
    expect(reads).toBe(0);
    const app = appWith(undefined);
    expect((await app.inject({ method: 'POST', url: '/internal/space-sync/v1/ingest', payload: {} })).statusCode).toBe(404);
    expect(spaceSyncWorkerOptions(off)).toEqual({ spaceAnalysisEnabled: false, spaceWorkMapEnabled: false, spaceStaleAfterMinutes: 24 * 60 });
    const runtime = createFounderStreamRuntime({ client: h.db.client, jobRepository: h.jobRepository,
      flags: { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false }, approvedChatIds: [chatId], ivyPrivateChatId: 'oc_p',
      analyzer: { async analyze() { return { topics: [] }; } }, ...spaceSyncWorkerOptions(off) });
    expect(runtime.supportedKinds).not.toContain('analyze_founder_stream_space_batch');
    expect(needsCodexAnalysis({ founderAnalysisEnabled: false, spaceSync: off })).toBe(false);
    await app.close(); h.db.close();
  });

  it('registers the signed ingest route with the trimmed secret file and the configured limits when ingest is on', async () => {
    const h = setup(); const paths: string[] = [];
    const config = { ...off, ingestEnabled: true, hmacSecretFile: '/app/secrets/space-sync-hmac', maxBlocks: 7 };
    const ingest = createSpaceSyncIngestDependencies({ config, client: h.db.client, jobRepository: h.jobRepository,
      readSecretFile: (path) => { paths.push(path); return `${secret}\n`; } })!;
    expect(paths).toEqual(['/app/secrets/space-sync-hmac']);
    expect(ingest).toMatchObject({ secret, signatureWindowSeconds: 300, maxBodyBytes: 2_000_000,
      ingestion: { limits: { maxBlocks: 7, maxComments: 2_000 }, spaceAnalysisEnabled: false } });
    const app = appWith(ingest);
    const unsigned = await app.inject({ method: 'POST', url: '/internal/space-sync/v1/ingest', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(unsigned.statusCode).toBe(400);
    const body = Buffer.from('{}'), timestamp = String(Math.floor(Date.now() / 1000));
    const signed = await app.inject({ method: 'POST', url: '/internal/space-sync/v1/ingest', payload: body, headers: {
      'content-type': 'application/json', 'x-space-sync-timestamp': timestamp, 'x-space-sync-sync-id': 's1',
      'x-space-sync-signature': computeSpaceSyncSignature({ timestamp, syncId: 's1', rawBody: body, secret }) } });
    expect(signed.statusCode).not.toBe(401);
    await app.close(); h.db.close();
  });

  it('refuses to start ingest with a missing or weak secret', () => {
    const h = setup();
    const config = { ...off, ingestEnabled: true, hmacSecretFile: '/app/secrets/space-sync-hmac' };
    expect(() => createSpaceSyncIngestDependencies({ config, client: h.db.client, jobRepository: h.jobRepository,
      readSecretFile: () => 'short\n' })).toThrow('SPACE_SYNC_HMAC_SECRET_INVALID');
    expect(() => createSpaceSyncIngestDependencies({ config: { ...config, hmacSecretFile: null }, client: h.db.client,
      jobRepository: h.jobRepository, readSecretFile: () => secret })).toThrow('SPACE_SYNC_HMAC_SECRET_INVALID');
    h.db.close();
  });

  it('turns on Space analysis in the worker and queues analysis from ingest only when the analysis flag is on', () => {
    const h = setup();
    const config = { ...off, ingestEnabled: true, analysisEnabled: true, hmacSecretFile: '/s', staleAfterMinutes: 90 };
    expect(spaceSyncWorkerOptions(config)).toEqual({ spaceAnalysisEnabled: true, spaceWorkMapEnabled: false, spaceStaleAfterMinutes: 90 });
    const ingest = createSpaceSyncIngestDependencies({ config, client: h.db.client, jobRepository: h.jobRepository, readSecretFile: () => secret })!;
    expect(ingest.ingestion).toMatchObject({ spaceAnalysisEnabled: true, jobRepository: h.jobRepository });
    const runtime = createFounderStreamRuntime({ client: h.db.client, jobRepository: h.jobRepository,
      flags: { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false }, approvedChatIds: [chatId], ivyPrivateChatId: 'oc_p',
      analyzer: { async analyze() { return { topics: [] }; } }, ...spaceSyncWorkerOptions(config) });
    expect(runtime.supportedKinds).toContain('analyze_founder_stream_space_batch');
    expect(needsCodexAnalysis({ founderAnalysisEnabled: false, spaceSync: config })).toBe(true);
    h.db.close();
  });
});
