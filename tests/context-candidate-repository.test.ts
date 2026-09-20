import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextCandidateRepository } from '../src/repositories/context-candidate-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { seedLegacyProjectRegistryFixture } from './helpers/project-registry-fixtures.js';

function fixture() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  seedLegacyProjectRegistryFixture(database.client);
  const sources = new ContextSourceRepository(database.client);
  const source = sources.saveSource({
    sourceSystem: 'fixture', sourceType: 'transcript', externalId: 'm1', logicalKey: 'fixture:m1',
    occurredAt: '2026-08-03T00:00:00.000Z', authors: [], locatorUri: null,
    contentFormat: 'text/plain', contentText: 'Ivy [0-10]: 进展是 reported。',
    metadata: { segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 10,
      text: '进展是 reported。' }] },
    availabilityStatus: 'available', capturedAt: new Date('2026-08-03T00:00:00.000Z')
  }).source;
  const run = sources.beginExtractionRun({
    sources: [{ id: source.id, contentHash: source.contentHash }], extractorName: 'fixture',
    extractorVersion: 'v1', promptVersion: 'v1', startedAt: new Date('2026-08-03T00:00:00.000Z')
  }).run;
  const evidence = sources.saveEvidence({
    sourceId: source.id, excerpt: '进展是 reported。', locator: { segmentOrdinal: 0,
      sourceVersion: 1, contentHash: source.contentHash, speakerName: 'Ivy', startMs: 0, endMs: 10 },
    evidenceLevel: 'primary_statement', capturedAt: new Date('2026-08-03T00:00:00.000Z')
  }).evidence;
  return { database, run, evidence };
}

describe('ContextCandidateRepository', () => {
  it('persists independent mapping/content confidence and deduplicates a candidate fingerprint', () => {
    const { database, run, evidence } = fixture();
    const repository = new ContextCandidateRepository(database.client);
    const input = {
      extractionRunId: run.id,
      candidateType: 'reported_progress' as const,
      scope: 'project' as const,
      summary: 'Phase 1E 进入实现',
      subjectKey: 'phase1e',
      structuredPayload: {},
      extractionConfidence: 0.91,
      factualStatus: 'reported' as const,
      projects: [{ projectKey: 'feishu-adaptor', role: 'primary' as const, mappingStatus: 'mapped' as const, confidence: 'low' as const, evidence: '提到 Phase 1E' }],
      evidence: [{ evidenceId: evidence.id, role: 'supporting' as const }],
      suggestedRelations: [],
      externalRefs: []
    };

    const first = repository.saveCandidate(input);
    const replay = repository.saveCandidate(input);

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, candidate: { id: first.candidate.id } });
    expect(repository.getCandidate(first.candidate.id)).toMatchObject({
      extractionConfidence: 0.91,
      factualStatus: 'reported',
      projects: [{ confidence: 'low' }]
    });
  });

  it('rejects candidates without supporting evidence or evidence outside the run source set', () => {
    const { database, run, evidence } = fixture();
    const repository = new ContextCandidateRepository(database.client);
    const base = {
      extractionRunId: run.id, candidateType: 'decision' as const, scope: 'company' as const,
      summary: '决定 A', subjectKey: null, structuredPayload: {}, extractionConfidence: 0.8,
      factualStatus: 'source_attested' as const, projects: [], suggestedRelations: [], externalRefs: []
    };
    expect(() => repository.saveCandidate({ ...base, evidence: [] })).toThrow(/supporting evidence/);

    const sources = new ContextSourceRepository(database.client);
    const otherSource = sources.saveSource({
      sourceSystem: 'fixture', sourceType: 'transcript', externalId: 'm2', logicalKey: 'fixture:m2',
      occurredAt: '2026-08-03T01:00:00.000Z', authors: [], locatorUri: null,
      contentFormat: 'text/plain', contentText: 'Ivy [0-1]: 另一份来源',
      metadata: { segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1,
        text: '另一份来源' }] }, availabilityStatus: 'available',
      capturedAt: new Date('2026-08-03T01:00:00.000Z')
    }).source;
    const outsideEvidence = sources.saveEvidence({ sourceId: otherSource.id, excerpt: '另一份来源',
      locator: { segmentOrdinal: 0, sourceVersion: 1, contentHash: otherSource.contentHash,
        speakerName: 'Ivy', startMs: 0, endMs: 1 }, evidenceLevel: 'primary_statement',
      capturedAt: new Date('2026-08-03T01:00:00.000Z') }).evidence;
    expect(() => repository.saveCandidate({
      ...base, evidence: [{ evidenceId: outsideEvidence.id, role: 'supporting' as const }]
    })).toThrow();
  });
});
