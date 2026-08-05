import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextCandidateRepository } from '../src/repositories/context-candidate-repository.js';
import { ContextRecordRepository } from '../src/repositories/context-record-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { registerContextReviewActionRoutes } from '../src/routes/context-review-actions.js';

function harness(expiresAt = '2030-01-02T00:00:00.000Z') {
  const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
  const sources = new ContextSourceRepository(database.client);
  const source = sources.saveSource({ sourceSystem: 'fixture', sourceType: 'transcript', externalId: 'm1', logicalKey: 'm1', occurredAt: '2026-08-03T00:00:00.000Z', authors: [], locatorUri: null, contentFormat: 'text/plain', contentText: 'Ivy [0-1000]: 进展 60%', metadata: { segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1000, text: '进展 60%' }] }, availabilityStatus: 'available', capturedAt: new Date('2026-08-03') }).source;
  const run = sources.beginExtractionRun({ sources: [{ id: source.id, contentHash: source.contentHash }], extractorName: 'fixture', extractorVersion: 'v1', promptVersion: 'p1', startedAt: new Date('2026-08-03') }).run;
  const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: '进展 60%', locator: { segmentOrdinal: 0,
    sourceVersion: 1, contentHash: source.contentHash, speakerName: 'Ivy', startMs: 0, endMs: 1000 },
    evidenceLevel: 'primary_statement', capturedAt: new Date('2026-08-03') }).evidence;
  const candidate = new ContextCandidateRepository(database.client).saveCandidate({ extractionRunId: run.id, candidateType: 'reported_progress', scope: 'project', summary: '进展 60%', subjectKey: 'phase1e', structuredPayload: {}, extractionConfidence: 0.8, factualStatus: 'reported', projects: [{ projectKey: 'feishu-adaptor', role: 'primary', mappingStatus: 'mapped', confidence: 'high', evidence: '明确项目' }], evidence: [{ evidenceId: evidence.id, role: 'supporting' }], suggestedRelations: [], externalRefs: [] }).candidate;
  const outbox = new OutboxRepository(database.client);
  outbox.enqueueContextReview({ kind: 'ivy_context_review', extractionRunId: run.id, targetChatId: 'oc_ivy',
    card: {}, cardNonce: 'nonce-1', expiresAt, candidateIds: [candidate.id], promotionIntents: [] });
  outbox.acknowledgeContextReviewDelivery({ extractionRunId: run.id, messageId: 'om_review', deliveredAt: new Date('2030-01-01T00:00:00.000Z') });
  const app = fastify();
  registerContextReviewActionRoutes(app, { verificationToken: 'verify', encryptKey: 'encrypt',
    ivyPrivateChatId: 'oc_ivy', approverOpenIds: ['ou_ivy'], outboxRepository: outbox,
    recordRepository: new ContextRecordRepository(database.client),
    now: () => new Date('2030-01-01T12:00:00.000Z') });
  const body = (overrides: Record<string, unknown> = {}) => ({ schema: '2.0',
    header: { token: 'verify', event_id: 'evt-card-1' },
    event: { operator: { operator_id: { open_id: 'ou_ivy' } },
      context: { open_chat_id: 'oc_ivy', open_message_id: 'om_review' },
      action: { value: { candidateId: candidate.id, action: 'approve_keep_status', expectedReviewStatus: 'pending', cardNonce: 'nonce-1', ...overrides } } } });
  return { app, database, candidate, body };
}

describe('Context review action callback', () => {
  it('rejects malformed encrypted callback input', async () => {
    const h = harness();
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions',
      payload: { encrypt: 'not-valid-ciphertext' } });
    expect(response.statusCode).toBe(400);
  });
  it('authorizes Ivy, preserves reported, and replays the same callback idempotently', async () => {
    const h = harness();
    const first = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: h.body() });
    const replay = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: h.body() });
    expect(first.statusCode).toBe(200); expect(replay.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ status: 'applied', factualStatus: 'reported' });
    expect(JSON.parse(replay.body)).toMatchObject({ status: 'replayed', factualStatus: 'reported' });
    expect(h.database.client.prepare('SELECT COUNT(*) AS count FROM context_record_versions').get()).toEqual({ count: 1 });
  });

  it('rejects unauthorized reviewers before any state change', async () => {
    const h = harness();
    const payload = h.body() as any; payload.event.operator.operator_id.open_id = 'ou_other';
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload });
    expect(response.statusCode).toBe(403);
    expect(h.database.client.prepare(`SELECT review_status FROM context_candidates WHERE id = ?`).get(h.candidate.id))
      .toEqual({ review_status: 'pending' });
  });

  it('rejects expired cards, bad nonces and nonexistent candidates', async () => {
    const expired = harness('2029-12-31T00:00:00.000Z');
    expect((await expired.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: expired.body() })).statusCode).toBe(409);
    const valid = harness();
    expect((await valid.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: valid.body({ cardNonce: 'wrong' }) })).statusCode).toBe(409);
    expect((await valid.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: valid.body({ candidateId: 'bad-id' }) })).statusCode).toBe(400);
    expect((await valid.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: valid.body({ candidateId: `ctxcand_${'0'.repeat(32)}` }) })).statusCode).toBe(404);
  });

  it('rejects a different second operation after the candidate is handled', async () => {
    const h = harness();
    await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: h.body() });
    const payload = h.body({ action: 'reject' }) as any; payload.header.event_id = 'evt-card-2';
    expect((await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload })).statusCode).toBe(409);
  });

  it.each([
    ['verification token', (payload: any) => { payload.header.token = 'wrong'; }, 401],
    ['chat ID', (payload: any) => { payload.event.context.open_chat_id = 'oc_other'; }, 403],
    ['message ID', (payload: any) => { payload.event.context.open_message_id = 'om_other'; }, 409]
  ] as const)('fails closed for a wrong %s', async (_label, mutate, status) => {
    const h = harness(); const payload = h.body() as any; mutate(payload);
    expect((await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload })).statusCode)
      .toBe(status);
    expect(h.database.client.prepare(`SELECT review_status FROM context_candidates WHERE id = ?`).get(h.candidate.id))
      .toEqual({ review_status: 'pending' });
  });

  it('rejects approve_verified tampering when the stored evidence is only a primary statement', async () => {
    const h = harness();
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions',
      payload: h.body({ action: 'approve_verified' }) });
    expect(response.statusCode).toBe(400);
    expect(h.database.client.prepare(`SELECT review_status, factual_status FROM context_candidates WHERE id = ?`)
      .get(h.candidate.id)).toEqual({ review_status: 'pending', factual_status: 'reported' });
  });

  it('rejects a same-run candidate that was not rendered on the delivered card', async () => {
    const h = harness();
    const row = h.database.client.prepare(`SELECT payload FROM outbox WHERE idempotency_key LIKE 'context-review:%'`).get() as
      { payload: string };
    const payload = JSON.parse(row.payload); payload.candidateIds = [];
    h.database.client.prepare(`UPDATE outbox SET payload = ? WHERE idempotency_key LIKE 'context-review:%'`)
      .run(JSON.stringify(payload));
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: h.body() });
    expect(response.statusCode).toBe(409);
  });

  it('allows only one of two concurrent different clicks to change state', async () => {
    const h = harness();
    const approve = h.body();
    const reject = h.body({ action: 'reject' }) as any; reject.header.event_id = 'evt-card-concurrent-2';
    const responses = await Promise.all([
      h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: approve }),
      h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions', payload: reject })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(h.database.client.prepare(`SELECT COUNT(*) AS count FROM context_reviews WHERE candidate_id = ?`).get(h.candidate.id))
      .toEqual({ count: 1 });
  });
});
