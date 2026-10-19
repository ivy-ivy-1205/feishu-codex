import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextCandidateRepository } from '../src/repositories/context-candidate-repository.js';
import { ContextRecordRepository } from '../src/repositories/context-record-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { seedLegacyProjectRegistryFixture } from './helpers/project-registry-fixtures.js';

function createCandidate(evidenceLevel: 'primary_statement' | 'direct_observation' = 'primary_statement') {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  seedLegacyProjectRegistryFixture(database.client);
  const sources = new ContextSourceRepository(database.client);
  const source = sources.saveSource({ sourceSystem: 'fixture', sourceType: 'transcript', externalId: 'm1', logicalKey: 'm1', occurredAt: '2026-08-03T00:00:00.000Z', authors: [], locatorUri: null, contentFormat: 'text/plain', contentText: 'Ivy [0-1000]: 已完成 60%', metadata: { segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1000, text: '已完成 60%' }] }, availabilityStatus: 'available', capturedAt: new Date('2026-08-03T00:00:00.000Z') }).source;
  const run = sources.beginExtractionRun({ sources: [{ id: source.id, contentHash: source.contentHash }], extractorName: 'fixture', extractorVersion: 'v1', promptVersion: 'v1', startedAt: new Date('2026-08-03T00:00:00.000Z') }).run;
  const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: '已完成 60%', locator: {
    segmentOrdinal: 0, sourceVersion: 1, contentHash: source.contentHash,
    speakerName: 'Ivy', startMs: 0, endMs: 1000 }, evidenceLevel,
    capturedAt: new Date('2026-08-03T00:00:00.000Z') }).evidence;
  const candidate = new ContextCandidateRepository(database.client).saveCandidate({ extractionRunId: run.id, candidateType: 'reported_progress', scope: 'project', summary: 'Phase 1E 已完成 60%', subjectKey: 'phase1e', structuredPayload: { percent: 60 }, extractionConfidence: 0.9, factualStatus: 'reported', projects: [{ projectKey: 'feishu-adaptor', role: 'primary', mappingStatus: 'mapped', confidence: 'high', evidence: '明确项目' }], evidence: [{ evidenceId: evidence.id, role: 'supporting' }], suggestedRelations: [], externalRefs: [] }).candidate;
  return { database, candidate };
}

describe('ContextRecordRepository', () => {
  it('promotes once transactionally and preserves reported after approval', () => {
    const { database, candidate } = createCandidate();
    const repository = new ContextRecordRepository(database.client);
    const input = { candidateId: candidate.id, expectedReviewStatus: 'pending' as const, reviewerOpenId: 'ivy', action: 'approve' as const, idempotencyKey: 'card:m1:c1:approve', reviewedAt: new Date('2026-08-03T01:00:00.000Z') };

    const approved = repository.promoteCandidate(input);
    const replay = repository.promoteCandidate(input);

    expect(approved).toMatchObject({ outcome: 'applied', reviewStatus: 'approved', factualStatus: 'reported', versionNumber: 1 });
    expect(replay).toMatchObject({ outcome: 'replayed', recordId: approved.recordId });
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_record_versions').get()).toEqual({ count: 1 });
    expect(repository.getVersionProvenance(approved.recordVersionId!)).toMatchObject({
      candidateId: candidate.id,
      evidence: [{ sourceVersion: 1, evidenceRole: 'supporting' }]
    });
  });

  it('creates immutable correction and supersession versions without overwriting history', () => {
    const { database, candidate } = createCandidate();
    const repository = new ContextRecordRepository(database.client);
    const v1 = repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy', action: 'approve', idempotencyKey: 'approve-v1', reviewedAt: new Date('2026-08-03T01:00:00.000Z') });
    database.client.prepare(`UPDATE context_candidates SET review_status = 'pending', candidate_fingerprint = 'second' WHERE id = ?`).run(candidate.id);
    const v2 = repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy', action: 'approve', targetRecordId: v1.recordId!, relationType: 'corrects', approvedSummary: 'Phase 1E 已完成 70%', idempotencyKey: 'approve-v2', reviewedAt: new Date('2026-08-03T02:00:00.000Z') });
    database.client.prepare(`UPDATE context_candidates SET review_status = 'pending' WHERE id = ?`).run(candidate.id);
    const v3 = repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy', action: 'approve', targetRecordId: v1.recordId!, relationType: 'supersedes', approvedSummary: 'Phase 1E 已完成并进入 Review', idempotencyKey: 'approve-v3', reviewedAt: new Date('2026-08-03T03:00:00.000Z') });

    expect(v2).toMatchObject({ outcome: 'applied', versionNumber: 2 });
    expect(v3).toMatchObject({ outcome: 'applied', versionNumber: 3 });
    expect(database.client.prepare(`SELECT version_number, summary FROM context_record_versions ORDER BY version_number`).all()).toEqual([
      { version_number: 1, summary: 'Phase 1E 已完成 60%' },
      { version_number: 2, summary: 'Phase 1E 已完成 70%' },
      { version_number: 3, summary: 'Phase 1E 已完成并进入 Review' }
    ]);
    expect(database.client.prepare(`SELECT relation_type FROM context_record_relations ORDER BY relation_type`).all())
      .toEqual([{ relation_type: 'corrects' }, { relation_type: 'supersedes' }]);
  });

  it('rolls back review and candidate state when version promotion cannot complete', () => {
    const { database, candidate } = createCandidate();
    const repository = new ContextRecordRepository(database.client);
    database.client.prepare(`INSERT INTO context_records (id, record_type, scope, subject_key, lifecycle_status, created_at, updated_at) VALUES ('empty-record', 'decision', 'project', NULL, 'active', '2026-08-03', '2026-08-03')`).run();
    expect(() => repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending',
      reviewerOpenId: 'ivy', action: 'approve', targetRecordId: 'empty-record', relationType: 'corrects',
      idempotencyKey: 'must-rollback', reviewedAt: new Date('2026-08-03T02:00:00.000Z') })).toThrow(/no version/);
    expect(database.client.prepare(`SELECT review_status FROM context_candidates WHERE id = ?`).get(candidate.id))
      .toEqual({ review_status: 'pending' });
    expect(database.client.prepare(`SELECT COUNT(*) AS count FROM context_reviews WHERE idempotency_key = 'must-rollback'`).get())
      .toEqual({ count: 0 });
  });

  it('records duplicates and conflicts without creating or overwriting a version', () => {
    const { database, candidate } = createCandidate();
    const repository = new ContextRecordRepository(database.client);
    const initial = repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy', action: 'approve', idempotencyKey: 'initial', reviewedAt: new Date('2026-08-03T01:00:00.000Z') });
    database.client.prepare(`UPDATE context_candidates SET review_status = 'pending' WHERE id = ?`).run(candidate.id);
    const duplicate = repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy', action: 'approve', targetRecordId: initial.recordId!, relationType: 'duplicates', idempotencyKey: 'duplicate', reviewedAt: new Date('2026-08-03T02:00:00.000Z') });
    expect(duplicate.versionNumber).toBeNull();
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM context_record_versions').get()).toEqual({ count: 1 });

    database.client.prepare(`UPDATE context_candidates SET review_status = 'pending' WHERE id = ?`).run(candidate.id);
    const conflict = repository.promoteCandidate({ candidateId: candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy', action: 'mark_conflict', targetRecordId: initial.recordId!, relationType: 'conflicts_with', idempotencyKey: 'conflict', reviewedAt: new Date('2026-08-03T03:00:00.000Z') });
    expect(conflict).toMatchObject({ reviewStatus: 'conflict', factualStatus: 'disputed' });
    expect(database.client.prepare('SELECT lifecycle_status FROM context_records WHERE id = ?').get(initial.recordId)).toEqual({ lifecycle_status: 'disputed' });
  });

  it('requires direct or authoritative evidence for an explicit evidence_verified decision', () => {
    const primary = createCandidate();
    expect(() => new ContextRecordRepository(primary.database.client).promoteCandidate({
      candidateId: primary.candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy',
      action: 'approve', decidedFactualStatus: 'evidence_verified', idempotencyKey: 'invalid-verify',
      reviewedAt: new Date('2026-08-03T01:00:00.000Z')
    })).toThrow(/direct or authoritative/);
    const direct = createCandidate('direct_observation');
    expect(new ContextRecordRepository(direct.database.client).promoteCandidate({
      candidateId: direct.candidate.id, expectedReviewStatus: 'pending', reviewerOpenId: 'ivy',
      action: 'approve', decidedFactualStatus: 'evidence_verified', idempotencyKey: 'explicit-verify',
      reviewedAt: new Date('2026-08-03T01:00:00.000Z')
    })).toMatchObject({ factualStatus: 'evidence_verified' });
  });
});
