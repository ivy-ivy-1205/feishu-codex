import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { ContextCandidateExtractorOutput } from '../src/ports/context-candidate-extractor.js';
import { ContextCandidateRepository } from '../src/repositories/context-candidate-repository.js';
import { ContextRecordRepository } from '../src/repositories/context-record-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { processContextCandidateJob } from '../src/services/context-candidate-worker.js';
import { seedLegacyProjectRegistryFixture } from './helpers/project-registry-fixtures.js';

const output: ContextCandidateExtractorOutput = { candidates: [
  {
    candidateType: 'decision', scope: 'project', summary: '决定周五上线', subjectKey: 'release',
    structuredPayload: {}, extractionConfidence: 0.93, factualStatus: 'source_attested',
    projectMappings: [{ projectKey: 'feishu-adaptor', role: 'primary', confidence: 'high', evidence: '明确提到 Phase 1E' }],
    evidence: [{ sourceId: '', excerpt: '决定周五上线', locator: {
      segmentOrdinal: 0, sourceVersion: 1, contentHash: 'SOURCE_HASH',
      speakerName: 'Ivy', startMs: 0, endMs: 1000
    }, evidenceLevel: 'primary_statement', role: 'supporting' }],
    suggestedRelations: [], externalRefs: []
  },
  {
    candidateType: 'claim', scope: 'project', summary: '目前还没有上线', subjectKey: 'release',
    structuredPayload: {}, extractionConfidence: 0.64, factualStatus: 'reported',
    projectMappings: [{ projectKey: 'feishu-adaptor', role: 'primary', confidence: 'low', evidence: '项目映射仍需确认' }],
    evidence: [{ sourceId: '', excerpt: '目前还没有上线', locator: {
      segmentOrdinal: 0, sourceVersion: 1, contentHash: 'SOURCE_HASH',
      speakerName: 'Ivy', startMs: 0, endMs: 1000
    }, evidenceLevel: 'primary_statement', role: 'supporting' }],
    suggestedRelations: [], externalRefs: []
  }
] };

function createHarness(extractorOutput: ContextCandidateExtractorOutput = output, sourceFixture?: {
  contentText: string;
  segments: Array<{ segmentOrdinal: number; speakerName: string; startMs: number; endMs: number; text: string }>;
}, leaseDurationMs = 180_000) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  seedLegacyProjectRegistryFixture(database.client);
  const sources = new ContextSourceRepository(database.client);
  const source = sources.saveSource({ sourceSystem: 'fixture', sourceType: 'transcript', externalId: 'm1',
    logicalKey: 'fixture:m1', occurredAt: '2026-08-03T00:00:00.000Z', authors: [], locatorUri: null,
    contentFormat: 'text/plain', contentText: sourceFixture?.contentText ?? 'Ivy [0-1000]: 决定周五上线，但目前还没有上线。',
    metadata: { segments: sourceFixture?.segments ?? [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0,
      endMs: 1000, text: '决定周五上线，但目前还没有上线。' }] },
    availabilityStatus: 'available', capturedAt: new Date('2026-08-03T00:00:00.000Z') }).source;
  const jobs = new JobRepository(database.client, { leaseDurationMs });
  jobs.enqueueContextExtraction({ sourceId: source.id, extractorVersion: 'v1', promptVersion: 'p1' });
  const job = jobs.leaseNextSupportedJob(new Date('2030-01-01T00:00:00.000Z'), ['extract_context_candidates']);
  if (!job || job.kind !== 'extract_context_candidates') throw new Error('expected context job');
  return { database, source, sources, jobs, job, dependencies: {
    sourceRepository: sources, candidateRepository: new ContextCandidateRepository(database.client),
    recordRepository: new ContextRecordRepository(database.client), projectRepository: new ProjectRepository(database.client),
    jobRepository: jobs, extractor: { async extract() { return { candidates: extractorOutput.candidates.map((candidate) => ({ ...candidate,
      evidence: candidate.evidence.map((evidence) => ({ ...evidence, sourceId: source.id,
        locator: { ...evidence.locator,
          ...(evidence.locator.contentHash === 'SOURCE_HASH' ? { contentHash: source.contentHash } : {}) } })) })) }; } },
    extractorName: 'fixture', extractorVersion: 'v1', promptVersion: 'p1',
    inputMaxBytes: 500_000, inputMaxSegments: 2_000,
    now: () => new Date('2030-01-01T00:00:01.000Z')
  } };
}

describe('processContextCandidateJob', () => {
  it('persists compound speech as atomic candidates with separate confidence dimensions', async () => {
    const harness = createHarness();
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    const candidates = harness.database.client.prepare(`
      SELECT summary, extraction_confidence, factual_status, review_status FROM context_candidates ORDER BY summary
    `).all();
    expect(candidates).toHaveLength(2);
    expect(harness.database.client.prepare(`
      SELECT mapping_confidence, mapping_status FROM context_candidate_projects ORDER BY mapping_confidence
    `).all()).toEqual([
      { mapping_confidence: 'high', mapping_status: 'mapped' },
      { mapping_confidence: 'low', mapping_status: 'needs_confirmation' }
    ]);
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get()).toEqual({ count: 2 });
  });

  it('safely creates no candidate for pure Todo extractor output', async () => {
    const harness = createHarness({ candidates: [] });
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get()).toEqual({ count: 0 });
  });

  it('fails invalid evidence without partial candidates and can be retried independently', async () => {
    const invalid = { candidates: [{ ...output.candidates[0]!, evidence: [{ ...output.candidates[0]!.evidence[0]!, excerpt: '不存在的原文' }] }] };
    const harness = createHarness(invalid);
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    expect(harness.database.client.prepare(`SELECT status FROM batch_jobs WHERE stable_key = ?`).get(harness.job.key))
      .toEqual({ status: 'failed' });
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get()).toEqual({ count: 0 });
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get()).toEqual({ count: 0 });
  });

  it.each([
    ['empty locator', {}],
    ['string ordinal', { segmentOrdinal: '0', sourceVersion: 1, contentHash: 'SOURCE_HASH', speakerName: 'Ivy', startMs: 0, endMs: 1000 }],
    ['negative ordinal', { segmentOrdinal: -1, sourceVersion: 1, contentHash: 'SOURCE_HASH', speakerName: 'Ivy', startMs: 0, endMs: 1000 }],
    ['out of bounds ordinal', { segmentOrdinal: 9, sourceVersion: 1, contentHash: 'SOURCE_HASH', speakerName: 'Ivy', startMs: 0, endMs: 1000 }],
    ['speaker mismatch', { segmentOrdinal: 0, sourceVersion: 1, contentHash: 'SOURCE_HASH', speakerName: 'Amy', startMs: 0, endMs: 1000 }],
    ['time mismatch', { segmentOrdinal: 0, sourceVersion: 1, contentHash: 'SOURCE_HASH', speakerName: 'Ivy', startMs: 1, endMs: 1000 }],
    ['version mismatch', { segmentOrdinal: 0, sourceVersion: 2, contentHash: 'SOURCE_HASH', speakerName: 'Ivy', startMs: 0, endMs: 1000 }],
    ['hash mismatch', { segmentOrdinal: 0, sourceVersion: 1, contentHash: 'f'.repeat(64), speakerName: 'Ivy', startMs: 0, endMs: 1000 }]
  ])('rejects %s without leaving partial evidence or candidates', async (_label, locator) => {
    const invalid = { candidates: [{ ...output.candidates[0]!, evidence: [{
      ...output.candidates[0]!.evidence[0]!, locator
    }] }] } as ContextCandidateExtractorOutput;
    const harness = createHarness(invalid);
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_evidence').get()).toEqual({ count: 0 });
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get()).toEqual({ count: 0 });
  });

  it('uses the locator ordinal to distinguish a repeated excerpt', async () => {
    const repeated = { candidates: [{ ...output.candidates[0]!, summary: '第二段的决定', evidence: [{
      ...output.candidates[0]!.evidence[0]!, excerpt: '重复内容', locator: {
        segmentOrdinal: 1, sourceVersion: 1, contentHash: 'SOURCE_HASH',
        speakerName: 'Amy', startMs: 11, endMs: 20
      }
    }] }] } as ContextCandidateExtractorOutput;
    const harness = createHarness(repeated, {
      contentText: 'Ivy [0-10]: 重复内容\nAmy [11-20]: 重复内容',
      segments: [
        { segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 10, text: '重复内容' },
        { segmentOrdinal: 1, speakerName: 'Amy', startMs: 11, endMs: 20, text: '重复内容' }
      ]
    });
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    const locator = harness.database.client.prepare('SELECT locator_json FROM context_evidence').get() as { locator_json: string };
    expect(JSON.parse(locator.locator_json)).toMatchObject({ segmentOrdinal: 1, speakerName: 'Amy' });
  });

  it('fails oversized extractor input without truncating or calling the extractor', async () => {
    const harness = createHarness();
    let called = false;
    harness.dependencies.extractor = { async extract() { called = true; return output; } };
    harness.dependencies.inputMaxBytes = Buffer.byteLength(harness.source.contentText, 'utf8') - 1;
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    expect(called).toBe(false);
    expect(harness.database.client.prepare(`SELECT status, payload FROM batch_jobs WHERE stable_key = ?`).get(harness.job.key))
      .toMatchObject({ status: 'failed', payload: expect.stringContaining('CONTEXT_EXTRACTOR_INPUT_BYTES_EXCEEDED') });
  });

  it('fails an extractor segment overflow without calling the extractor', async () => {
    const harness = createHarness();
    let called = false;
    harness.dependencies.extractor = { async extract() { called = true; return output; } };
    harness.dependencies.inputMaxSegments = 0;
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('completed');
    expect(called).toBe(false);
    expect(harness.database.client.prepare(`SELECT payload FROM batch_jobs WHERE stable_key = ?`).get(harness.job.key))
      .toMatchObject({ payload: expect.stringContaining('CONTEXT_EXTRACTOR_INPUT_SEGMENTS_EXCEEDED') });
  });

  it('does not persist after its lease is lost', async () => {
    const harness = createHarness();
    harness.dependencies.now = () => new Date(harness.job.leaseExpiresAt!);
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('lost_lease');
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get()).toEqual({ count: 0 });
  });

  it('does not let an expired worker overwrite a reclaimed worker successful run', async () => {
    const harness = createHarness(output, undefined, 1_000);
    let rejectA!: (reason: unknown) => void;
    const blockedA = new Promise<ContextCandidateExtractorOutput>((_resolve, reject) => { rejectA = reject; });
    let aNow = new Date('2030-01-01T00:00:00.100Z');
    const workerA = { ...harness.dependencies,
      extractor: { async extract() { return blockedA; } }, now: () => aNow };
    const pendingA = processContextCandidateJob(harness.job, workerA);
    await new Promise((resolve) => setImmediate(resolve));

    const reclaimedAt = new Date('2030-01-01T00:00:01.001Z');
    const jobB = harness.jobs.leaseNextSupportedJob(reclaimedAt, ['extract_context_candidates']);
    if (!jobB || jobB.kind !== 'extract_context_candidates') throw new Error('expected worker B to reclaim');
    let outboxWrites = 0;
    const workerB = { ...harness.dependencies, now: () => new Date('2030-01-01T00:00:01.002Z'),
      onPersisted: () => { outboxWrites += 1; } };
    expect(await processContextCandidateJob(jobB, workerB)).toBe('completed');

    aNow = new Date('2030-01-01T00:00:01.003Z');
    rejectA(new Error('CONTEXT_PERMANENT_FIXTURE_FAILURE'));
    expect(await pendingA).toBe('lost_lease');
    expect(harness.database.client.prepare('SELECT status, error_code FROM context_extraction_runs').get())
      .toEqual({ status: 'completed', error_code: null });
    expect(harness.database.client.prepare(`SELECT status FROM batch_jobs WHERE stable_key = ?`).get(harness.job.key))
      .toEqual({ status: 'completed' });
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get())
      .toEqual({ count: 2 });
    expect(outboxWrites).toBe(1);
  });

  it('retries a transient Codex failure and then completes without duplicate candidates', async () => {
    const harness = createHarness();
    let calls = 0;
    harness.dependencies.extractor = { async extract() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'CODEX_EXECUTION_FAILED' });
      return { candidates: output.candidates.map((candidate) => ({ ...candidate,
        evidence: candidate.evidence.map((evidence) => ({ ...evidence, sourceId: harness.source.id,
          locator: { ...evidence.locator, contentHash: harness.source.contentHash } })) })) };
    } };
    expect(await processContextCandidateJob(harness.job, harness.dependencies)).toBe('retry');
    const retryAt = new Date('2030-01-01T00:00:02.000Z');
    const retryJob = harness.jobs.leaseNextSupportedJob(retryAt, ['extract_context_candidates']);
    if (!retryJob || retryJob.kind !== 'extract_context_candidates') throw new Error('expected retry job');
    harness.dependencies.now = () => retryAt;
    expect(await processContextCandidateJob(retryJob, harness.dependencies)).toBe('completed');
    expect(harness.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get()).toEqual({ count: 2 });
  });
});
