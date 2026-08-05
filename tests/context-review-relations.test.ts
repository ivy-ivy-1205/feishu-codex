import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextCandidateRepository } from '../src/repositories/context-candidate-repository.js';
import { ContextRecordRepository } from '../src/repositories/context-record-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { registerContextReviewActionRoutes } from '../src/routes/context-review-actions.js';
import { initialFactualStatusFor, type ContextCandidateType } from '../src/domain/context.js';

const at = new Date('2026-08-03T00:00:00.000Z');

function addCandidate(client: ReturnType<typeof createSqliteDatabase>['client'], input: {
  key: string; text: string; scope?: 'company' | 'project'; suggestedRelations?: Array<{
    recordId: string; relationType: 'supplements' | 'confirms' | 'corrects' | 'supersedes' | 'duplicates'; rationale: string
  }>; candidateType?: ContextCandidateType;
}) {
  const sources = new ContextSourceRepository(client);
  const contentText = `Ivy [0-1000]: ${input.text}`;
  const source = sources.saveSource({ sourceSystem: 'fixture', sourceType: 'minute_transcript',
    externalId: input.key, logicalKey: input.key, occurredAt: at.toISOString(), authors: [], locatorUri: null,
    contentFormat: 'text/plain', contentText,
    metadata: { segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1000,
      text: input.text }] },
    availabilityStatus: 'available', capturedAt: at }).source;
  const run = sources.beginExtractionRun({ sources: [{ id: source.id, contentHash: source.contentHash }],
    extractorName: 'fixture', extractorVersion: 'v1', promptVersion: input.key, startedAt: at }).run;
  const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: input.text,
    locator: { segmentOrdinal: 0, sourceVersion: 1, contentHash: source.contentHash,
      speakerName: 'Ivy', startMs: 0, endMs: 1000 }, evidenceLevel: 'primary_statement', capturedAt: at }).evidence;
  return { run, candidate: new ContextCandidateRepository(client).saveCandidate({ extractionRunId: run.id,
    candidateType: input.candidateType ?? 'decision', scope: input.scope ?? 'project', summary: input.text, subjectKey: input.key,
    structuredPayload: {}, extractionConfidence: 0.9,
    factualStatus: initialFactualStatusFor(input.candidateType ?? 'decision'),
    projects: input.scope === 'company' ? [] : [{ projectKey: 'feishu-adaptor', role: 'primary',
      mappingStatus: 'mapped', confidence: 'high', evidence: 'fixture' }],
    evidence: [{ evidenceId: evidence.id, role: 'supporting' }],
    suggestedRelations: input.suggestedRelations ?? [], externalRefs: [] }).candidate };
}

function relationHarness(options: { archived?: boolean; scopeMismatch?: boolean; multiple?: boolean;
  missingTargetIntent?: boolean } = {}) {
  const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
  const records = new ContextRecordRepository(database.client);
  const original = addCandidate(database.client, { key: 'source-a', text: '原始 Context 正文。' });
  const target = records.promoteCandidate({ candidateId: original.candidate.id, expectedReviewStatus: 'pending',
    reviewerOpenId: 'ou_ivy', action: 'approve', idempotencyKey: 'target-a', reviewedAt: at });
  const targetIds = [target.recordId!];
  if (options.multiple) {
    const other = addCandidate(database.client, { key: 'source-other', text: '另一条 Context。' });
    targetIds.push(records.promoteCandidate({ candidateId: other.candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ou_ivy', action: 'approve', idempotencyKey: 'target-b', reviewedAt: at }).recordId!);
  }
  if (options.archived) database.client.prepare(`UPDATE context_records SET lifecycle_status = 'archived' WHERE id = ?`).run(targetIds[0]);
  if (options.scopeMismatch) database.client.prepare(`UPDATE context_records SET scope = 'company' WHERE id = ?`).run(targetIds[0]);
  const incoming = addCandidate(database.client, { key: 'source-b', text: '新增补充细节。',
    suggestedRelations: targetIds.map((recordId) => ({ recordId, relationType: 'supplements' as const, rationale: 'AI suggestion' })) });
  const intents = targetIds.map((recordId, index) => ({ id: `ctxpi_${String(index + 1).padStart(32, 'a')}`,
    candidateId: incoming.candidate.id,
    targetRecordId: options.missingTargetIntent && index === 0 ? `ctxrec_${'f'.repeat(32)}` : recordId,
    relationType: 'supplements' as const }));
  const outbox = new OutboxRepository(database.client);
  outbox.enqueueContextReview({ kind: 'ivy_context_review', extractionRunId: incoming.run.id,
    targetChatId: 'oc_ivy', card: {}, cardNonce: 'nonce', expiresAt: '2030-01-02T00:00:00.000Z',
    candidateIds: [incoming.candidate.id], promotionIntents: intents });
  outbox.acknowledgeContextReviewDelivery({ extractionRunId: incoming.run.id, messageId: 'om_relation',
    deliveredAt: new Date('2030-01-01T00:00:00.000Z') });
  const app = fastify();
  registerContextReviewActionRoutes(app, { verificationToken: 'verify', encryptKey: 'encrypt',
    ivyPrivateChatId: 'oc_ivy', approverOpenIds: ['ou_ivy'], outboxRepository: outbox,
    recordRepository: records, now: () => new Date('2030-01-01T12:00:00.000Z') });
  const body = (value: Record<string, unknown>) => ({ schema: '2.0', header: { token: 'verify', event_id: 'evt' },
    event: { operator: { operator_id: { open_id: 'ou_ivy' } },
      context: { open_chat_id: 'oc_ivy', open_message_id: 'om_relation' },
      action: { value: { candidateId: incoming.candidate.id, expectedReviewStatus: 'pending',
        cardNonce: 'nonce', ...value } } } });
  return { app, body, database, incoming, targetIds, intents };
}

describe('Context relation review intents', () => {
  it('ordinary approval creates an independent Context even when AI suggested relations exist', async () => {
    const h = relationHarness({ multiple: true });
    expect((await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions',
      payload: h.body({ action: 'approve_keep_status' }) })).statusCode).toBe(200);
    expect(h.database.client.prepare('SELECT COUNT(*) AS count FROM context_record_relations').get()).toEqual({ count: 0 });
    expect(h.database.client.prepare('SELECT COUNT(*) AS count FROM context_records').get()).toEqual({ count: 3 });
  });

  it('writes a relation only after Ivy explicitly selects the server intent', async () => {
    const h = relationHarness();
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions',
      payload: h.body({ action: 'apply_suggested_relation', promotionIntentId: h.intents[0]!.id }) });
    expect(response.statusCode).toBe(200);
    expect(h.database.client.prepare('SELECT relation_type FROM context_record_relations').all())
      .toEqual([{ relation_type: 'supplements' }]);
  });

  it.each([
    ['invented intent', {}, `ctxpi_${'f'.repeat(32)}`],
    ['archived target', { archived: true }, null],
    ['scope mismatch', { scopeMismatch: true }, null],
    ['missing target', { missingTargetIntent: true }, null]
  ] as const)('fails closed for %s', async (_label, options, overriddenIntent) => {
    const h = relationHarness(options);
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions',
      payload: h.body({ action: 'apply_suggested_relation',
        promotionIntentId: overriddenIntent ?? h.intents[0]!.id }) });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.database.client.prepare(`SELECT review_status FROM context_candidates WHERE id = ?`).get(h.incoming.candidate.id))
      .toEqual({ review_status: 'pending' });
  });

  it('rejects client-supplied relation and target fields', async () => {
    const h = relationHarness();
    const response = await h.app.inject({ method: 'POST', url: '/webhooks/feishu/card-actions',
      payload: h.body({ action: 'approve_keep_status', relationType: 'supersedes', targetRecordId: h.targetIds[0] }) });
    expect(response.statusCode).toBe(400);
  });

  it('builds a complete supplements projection with old and new provenance', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const records = new ContextRecordRepository(database.client);
    const original = addCandidate(database.client, { key: 'supplement-a', text: '公司审核策略要求 Ivy 人工确认。' });
    const v1 = records.promoteCandidate({ candidateId: original.candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ou_ivy', action: 'approve', idempotencyKey: 'supplement-v1', reviewedAt: at });
    const supplement = addCandidate(database.client, { key: 'supplement-b', text: '审核卡片必须保留来源定位。',
      suggestedRelations: [{ recordId: v1.recordId!, relationType: 'supplements', rationale: '新增细节' }] });
    const v2 = records.promoteCandidate({ candidateId: supplement.candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ou_ivy', action: 'approve', targetRecordId: v1.recordId!, relationType: 'supplements',
      idempotencyKey: 'supplement-v2', reviewedAt: new Date('2026-08-03T01:00:00.000Z') });

    const current = records.listCurrentSummaries().find((record) => record.id === v1.recordId);
    expect(current?.summary).toContain('公司审核策略要求 Ivy 人工确认。');
    expect(current?.summary).toContain('审核卡片必须保留来源定位。');
    expect(records.getVersionProvenance(v1.recordVersionId!)?.evidence).toHaveLength(1);
    expect(records.getVersionProvenance(v2.recordVersionId!)?.evidence).toHaveLength(2);
    expect(database.client.prepare(`SELECT version_number, summary FROM context_record_versions
      WHERE record_id = ? ORDER BY version_number`).all(v1.recordId)).toEqual([
      { version_number: 1, summary: '公司审核策略要求 Ivy 人工确认。' },
      { version_number: 2, summary: expect.stringContaining('审核卡片必须保留来源定位。') }
    ]);
  });

  it('uses distinct sources and candidates for confirms, corrects, supersedes and duplicates', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const records = new ContextRecordRepository(database.client);
    const original = addCandidate(database.client, { key: 'relation-v1', text: '策略版本一。' });
    const v1 = records.promoteCandidate({ candidateId: original.candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ou_ivy', action: 'approve', idempotencyKey: 'relation-v1', reviewedAt: at });
    const apply = (key: string, text: string, relationType: 'confirms' | 'corrects' | 'supersedes' | 'duplicates') => {
      const next = addCandidate(database.client, { key, text,
        suggestedRelations: [{ recordId: v1.recordId!, relationType, rationale: key }] });
      return records.promoteCandidate({ candidateId: next.candidate.id, expectedReviewStatus: 'pending',
        reviewerOpenId: 'ou_ivy', action: 'approve', targetRecordId: v1.recordId!, relationType,
        idempotencyKey: key, reviewedAt: new Date(at.getTime() + Number(key.slice(-1)) * 1_000) });
    };
    const v2 = apply('relation-v2', '再次确认策略版本一。', 'confirms');
    const v3 = apply('relation-v3', '纠正后的策略。', 'corrects');
    const v4 = apply('relation-v4', '新政策已经取代旧政策。', 'supersedes');
    const duplicate = apply('relation-v5', '新政策已经取代旧政策。', 'duplicates');
    expect([v2.versionNumber, v3.versionNumber, v4.versionNumber, duplicate.versionNumber])
      .toEqual([2, 3, 4, null]);
    expect(records.getVersionProvenance(v2.recordVersionId!)?.evidence).toHaveLength(2);
    expect(database.client.prepare(`SELECT relation_type FROM context_record_relations ORDER BY created_at`).all())
      .toEqual([{ relation_type: 'confirms' }, { relation_type: 'corrects' }, { relation_type: 'supersedes' }]);
    expect(database.client.prepare('SELECT COUNT(DISTINCT source_id) AS count FROM context_evidence').get())
      .toEqual({ count: 5 });
  });

  it('rolls back the whole promotion when relation insertion fails after version writes', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const records = new ContextRecordRepository(database.client);
    const original = addCandidate(database.client, { key: 'rollback-a', text: '回滚前正文。' });
    const v1 = records.promoteCandidate({ candidateId: original.candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ou_ivy', action: 'approve', idempotencyKey: 'rollback-v1', reviewedAt: at });
    const correction = addCandidate(database.client, { key: 'rollback-b', text: '会触发 relation 失败。',
      suggestedRelations: [{ recordId: v1.recordId!, relationType: 'corrects', rationale: 'fixture' }] });
    database.client.exec(`CREATE TRIGGER fail_context_relation BEFORE INSERT ON context_record_relations
      BEGIN SELECT RAISE(ABORT, 'fixture relation failure'); END`);
    expect(() => records.promoteCandidate({ candidateId: correction.candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ou_ivy', action: 'approve', targetRecordId: v1.recordId!, relationType: 'corrects',
      idempotencyKey: 'rollback-v2', reviewedAt: new Date('2026-08-03T01:00:00.000Z') })).toThrow(/fixture relation failure/);
    expect(database.client.prepare(`SELECT review_status FROM context_candidates WHERE id = ?`).get(correction.candidate.id))
      .toEqual({ review_status: 'pending' });
    expect(database.client.prepare(`SELECT COUNT(*) AS count FROM context_record_versions WHERE record_id = ?`).get(v1.recordId))
      .toEqual({ count: 1 });
    expect(database.client.prepare(`SELECT COUNT(*) AS count FROM context_reviews WHERE idempotency_key = 'rollback-v2'`).get())
      .toEqual({ count: 0 });
  });

  it.each([
    'proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker',
    'requirement', 'status_update', 'action_item'
  ] as const)('preserves the locked initial factual status when promoting %s', (candidateType) => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const candidate = addCandidate(database.client, { key: `promote-${candidateType}`,
      text: `${candidateType} fixture`, candidateType }).candidate;
    expect(new ContextRecordRepository(database.client).promoteCandidate({ candidateId: candidate.id,
      expectedReviewStatus: 'pending', reviewerOpenId: 'ou_ivy', action: 'approve',
      idempotencyKey: `promote-${candidateType}`, reviewedAt: at }).factualStatus)
      .toBe(initialFactualStatusFor(candidateType));
  });
});
