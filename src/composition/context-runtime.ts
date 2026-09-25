import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CodexCliAdapter, NodeCodexProcessRunner } from '../adapters/codex-cli.js';
import type { CodexModel, CodexReasoningEffort } from '../adapters/codex-cli.js';
import { CodexContextCandidateExtractor } from '../adapters/codex-context-candidate-extractor.js';
import type { ContextCandidateExtractor } from '../ports/context-candidate-extractor.js';
import { ContextCandidateRepository } from '../repositories/context-candidate-repository.js';
import { ContextRecordRepository } from '../repositories/context-record-repository.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import type { JobRepository } from '../repositories/job-repository.js';
import type { OutboxRepository } from '../repositories/outbox-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { ContextCandidateWorkerDependencies } from '../services/context-candidate-worker.js';
import { renderContextReviewCard } from '../services/context-review-renderer.js';

export const contextExtractorVersion = 'phase1e-v2';
export const contextPromptVersion = 'context-v1';
const reviewCardLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

export interface CreateContextRuntimeOptions {
  client: Database.Database;
  jobRepository: JobRepository;
  outboxRepository: OutboxRepository;
  projectRepository: ProjectRepository;
  targetChatId: string;
  reviewEnabled: boolean;
  codex: { command: string; model?: CodexModel; reasoningEffort?: CodexReasoningEffort;
    workdir: string; timeoutSeconds: number };
  env?: Record<string, string | undefined>;
  extractor?: ContextCandidateExtractor;
  sourceMaxBytes?: number;
  sourceMaxSegments?: number;
  extractorMaxBytes?: number;
  extractorMaxSegments?: number;
}

export interface ContextRuntime {
  sourceRepository: ContextSourceRepository;
  candidateRepository: ContextCandidateRepository;
  recordRepository: ContextRecordRepository;
  capture: { enabled: true; sourceRepository: ContextSourceRepository; extractorVersion: string; promptVersion: string;
    sourceMaxBytes: number; sourceMaxSegments: number };
  worker: ContextCandidateWorkerDependencies;
}

export function createContextRuntime(options: CreateContextRuntimeOptions): ContextRuntime {
  const sourceRepository = new ContextSourceRepository(options.client);
  const candidateRepository = new ContextCandidateRepository(options.client);
  const recordRepository = new ContextRecordRepository(options.client);
  const extractor = options.extractor ?? new CodexContextCandidateExtractor({
    codex: new CodexCliAdapter({ command: options.codex.command, workdir: options.codex.workdir,
      timeoutMs: options.codex.timeoutSeconds * 1_000, baseEnv: options.env ?? process.env,
      ...(options.codex.model ? { model: options.codex.model } : {}),
      ...(options.codex.reasoningEffort ? { reasoningEffort: options.codex.reasoningEffort } : {}),
      runner: new NodeCodexProcessRunner() })
  });
  const worker: ContextCandidateWorkerDependencies = {
    sourceRepository, candidateRepository, recordRepository,
    projectRepository: options.projectRepository, jobRepository: options.jobRepository,
    extractor, extractorName: 'codex-cli', extractorVersion: contextExtractorVersion,
    promptVersion: contextPromptVersion,
    inputMaxBytes: options.extractorMaxBytes ?? 500_000,
    inputMaxSegments: options.extractorMaxSegments ?? 2_000,
    ...(options.reviewEnabled ? { onPersisted: ({ extractionRunId, candidateIds, persistedAt }) => {
      if (candidateIds.length === 0) return;
      const candidates = candidateIds.map((id) => candidateRepository.getCandidate(id))
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
      const primarySource = sourceRepository.getRunSources(extractionRunId)[0];
      const cardNonce = randomBytes(24).toString('base64url');
      const promotionIntents = candidates.flatMap((candidate) => candidate.suggestedRelations.map((relation) => ({
        id: `ctxpi_${randomBytes(16).toString('hex')}`,
        candidateId: candidate.id,
        targetRecordId: relation.recordId,
        relationType: relation.relationType
      })));
      const expiresAt = new Date(persistedAt.getTime() + reviewCardLifetimeMs).toISOString();
      options.outboxRepository.enqueueContextReview({
        kind: 'ivy_context_review', extractionRunId, targetChatId: options.targetChatId,
        cardNonce, expiresAt, candidateIds: candidates.map((candidate) => candidate.id), promotionIntents,
        card: renderContextReviewCard({
          meetingTitle: typeof primarySource?.metadata.title === 'string'
            ? primarySource.metadata.title : '企业 Context 候选',
          extractionRunId, candidates, cardNonce, promotionIntents
        })
      });
    } } : {})
  };
  return {
    sourceRepository, candidateRepository, recordRepository,
    capture: { enabled: true, sourceRepository, extractorVersion: contextExtractorVersion,
      promptVersion: contextPromptVersion, sourceMaxBytes: options.sourceMaxBytes ?? 2_000_000,
      sourceMaxSegments: options.sourceMaxSegments ?? 10_000 },
    worker
  };
}
