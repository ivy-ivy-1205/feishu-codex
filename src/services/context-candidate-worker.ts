import { z } from 'zod';
import {
  contextCandidateExtractorOutputSchema,
  type ContextCandidateExtractor
} from '../ports/context-candidate-extractor.js';
import { ContextCandidateRepository } from '../repositories/context-candidate-repository.js';
import { ContextRecordRepository } from '../repositories/context-record-repository.js';
import { ContextSourceRepository, type ContextSourceRecord } from '../repositories/context-source-repository.js';
import { JobRepository, LeaseLostError, type ExtractContextCandidatesJob } from '../repositories/job-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { ProjectRepositoryContextProvider } from './project-context.js';
import { validateTranscriptEvidenceLocator } from './context-evidence-locator.js';

const contextRetryBudget = 3;

export interface ContextCandidateWorkerDependencies {
  sourceRepository: ContextSourceRepository;
  candidateRepository: ContextCandidateRepository;
  recordRepository: ContextRecordRepository;
  projectRepository: ProjectRepository;
  jobRepository: JobRepository;
  extractor: ContextCandidateExtractor;
  extractorName: string;
  extractorVersion: string;
  promptVersion: string;
  inputMaxBytes: number;
  inputMaxSegments: number;
  now?: () => Date;
  onPersisted?: (input: { extractionRunId: string; candidateIds: readonly string[]; persistedAt: Date }) => void;
}

export async function processContextCandidateJob(
  job: ExtractContextCandidatesJob,
  dependencies: ContextCandidateWorkerDependencies
): Promise<'completed' | 'retry' | 'lost_lease'> {
  assertSharedClient(dependencies);
  const now = dependencies.now ?? (() => new Date());
  let runId: string | null = null;
  try {
    const source = dependencies.sourceRepository.getSource(job.sourceId);
    if (!source) return failPermanently(job, dependencies, 'CONTEXT_SOURCE_NOT_FOUND', now());
    validateExtractorInputLimits(source, dependencies.inputMaxBytes, dependencies.inputMaxSegments);
    const begun = dependencies.sourceRepository.beginExtractionRun({
      sources: [{ id: source.id, contentHash: source.contentHash }],
      extractorName: dependencies.extractorName,
      extractorVersion: dependencies.extractorVersion,
      promptVersion: dependencies.promptVersion,
      startedAt: now()
    });
    runId = begun.run.id;
    if (begun.run.status === 'completed') {
      dependencies.jobRepository.markCompleted(job, now());
      return 'completed';
    }
    const projects = await new ProjectRepositoryContextProvider(dependencies.projectRepository).getProjectCards();
    const extracted = contextCandidateExtractorOutputSchema.parse(await dependencies.extractor.extract({
      sources: dependencies.sourceRepository.getRunSources(runId),
      projects,
      existingRecords: dependencies.recordRepository.listCurrentSummaries()
    }));
    const operationNow = now();
    dependencies.sourceRepository.client.transaction(() => {
      if (!dependencies.jobRepository.ownsLease(job, operationNow)) throw new LeaseLostError(job.key);
      const ids: string[] = [];
      for (const candidate of extracted.candidates) {
        const evidence = candidate.evidence.map((item) => {
          const evidenceSource = dependencies.sourceRepository.getSource(item.sourceId);
          validateTranscriptEvidenceLocator(evidenceSource, item.excerpt, item.locator);
          return {
            evidenceId: dependencies.sourceRepository.saveEvidence({
              sourceId: item.sourceId, excerpt: item.excerpt, locator: item.locator,
              evidenceLevel: item.evidenceLevel, capturedAt: operationNow
            }).evidence.id,
            role: item.role
          };
        });
        const saved = dependencies.candidateRepository.saveCandidate({
          extractionRunId: runId!, candidateType: candidate.candidateType,
          scope: candidate.scope, summary: candidate.summary, subjectKey: candidate.subjectKey,
          structuredPayload: candidate.structuredPayload,
          extractionConfidence: candidate.extractionConfidence, factualStatus: candidate.factualStatus,
          projects: candidate.projectMappings.map((mapping) => ({
            projectKey: mapping.projectKey, role: mapping.role,
            mappingStatus: mapping.projectKey === null ? 'unmapped'
              : mapping.confidence === 'high' ? 'mapped' : 'needs_confirmation',
            confidence: mapping.confidence, evidence: mapping.evidence
          })),
          evidence, suggestedRelations: candidate.suggestedRelations,
          externalRefs: candidate.externalRefs
        });
        ids.push(saved.candidate.id);
      }
      dependencies.sourceRepository.completeExtractionRun(runId!, operationNow);
      dependencies.onPersisted?.({ extractionRunId: runId!, candidateIds: ids, persistedAt: operationNow });
      dependencies.jobRepository.markCompleted(job, operationNow);
    })();
    return 'completed';
  } catch (error) {
    if (error instanceof LeaseLostError) return 'lost_lease';
    const operationNow = now();
    if (isRetriableContextError(error) && job.attempt + 1 < contextRetryBudget) {
      try {
        dependencies.jobRepository.markContextRetry(job,
          new Date(operationNow.getTime() + Math.min(1_000 * 2 ** job.attempt, 60_000)), operationNow);
        return 'retry';
      } catch (failure) {
        if (failure instanceof LeaseLostError) return 'lost_lease';
        throw failure;
      }
    }
    if (!runId) return failPermanently(job, dependencies, failureCode(error), operationNow);
    try {
      const applied = dependencies.sourceRepository.client.transaction(() => {
        if (!dependencies.jobRepository.ownsLease(job, operationNow)) return false;
        dependencies.sourceRepository.failExtractionRun(runId!, failureCode(error), operationNow);
        dependencies.jobRepository.markContextFailed(job, failureCode(error), operationNow);
        return true;
      })();
      return applied ? 'completed' : 'lost_lease';
    } catch (failure) {
      if (failure instanceof LeaseLostError) return 'lost_lease';
      throw failure;
    }
  }
}

function validateExtractorInputLimits(source: ContextSourceRecord, maxBytes: number, maxSegments: number): void {
  if (Buffer.byteLength(source.contentText, 'utf8') > maxBytes) {
    throw new Error('CONTEXT_EXTRACTOR_INPUT_BYTES_EXCEEDED');
  }
  const segments = source.metadata.segments;
  if (!Array.isArray(segments)) throw new Error('CONTEXT_EVIDENCE_SOURCE_SEGMENTS_INVALID');
  if (segments.length > maxSegments) throw new Error('CONTEXT_EXTRACTOR_INPUT_SEGMENTS_EXCEEDED');
}

function isRetriableContextError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error.code === 'CODEX_EXECUTION_FAILED' || error.code === 'RATE_LIMITED'));
}

function failureCode(error: unknown): string {
  if (error instanceof z.ZodError) return 'CONTEXT_EXTRACTOR_OUTPUT_INVALID';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^CONTEXT_[A-Z_]+$/.test(error.message)) return error.message;
  return 'CONTEXT_EXTRACTION_FAILED';
}

function failPermanently(job: ExtractContextCandidatesJob, dependencies: ContextCandidateWorkerDependencies,
  code: string, at: Date): 'completed' | 'lost_lease' {
  try { dependencies.jobRepository.markContextFailed(job, code, at); return 'completed'; }
  catch (error) { if (error instanceof LeaseLostError) return 'lost_lease'; throw error; }
}

function assertSharedClient(dependencies: ContextCandidateWorkerDependencies): void {
  const client = dependencies.sourceRepository.client;
  if (dependencies.candidateRepository.client !== client || dependencies.recordRepository.client !== client ||
    dependencies.projectRepository.client !== client || dependencies.jobRepository.client !== client) {
    throw new Error('Context worker repositories must use the same SQLite client');
  }
}
