import { z } from 'zod';
import { MinuteContext, type FeishuMinutesReader } from '../ports/feishu.js';
import {
  parseMeetingSummaryDraft,
  SummarizerOutputValidationError,
  type MeetingSummarizer
} from '../ports/summarizer.js';
import {
  JobRepository,
  LeaseLostError,
  type ProcessMinuteJob,
  type RetryErrorCode
} from '../repositories/job-repository.js';
import { MeetingRepository } from '../repositories/meeting-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import {
  captureMinuteTranscriptSource,
  ContextCaptureError,
  type ContextCaptureFailureCode
} from './context-source-capture.js';
import { mapTodoToProject } from './project-mapper.js';
import {
  MeetingSummaryRenderError,
  renderMeetingSummary
} from './summary-renderer.js';
import { MinuteTranscriptParseError } from '../adapters/minute-transcript-parser.js';

const maximumRetryDelayMs = 60_000;
const retryBudgets = {
  MINUTE_NOT_READY: 8,
  RATE_LIMITED: 5
} as const satisfies Record<RetryErrorCode, number>;

export interface MeetingWorkerDependencies {
  reader: FeishuMinutesReader;
  summarizer: MeetingSummarizer;
  meetingRepository: MeetingRepository;
  jobRepository: JobRepository;
  outboxRepository: OutboxRepository;
  targetChatId: string;
  now?: () => Date;
  context?: {
    enabled: false;
  } | {
    enabled: true;
    sourceRepository: ContextSourceRepository;
    extractorVersion: string;
    promptVersion: string;
    sourceMaxBytes: number;
    sourceMaxSegments: number;
  };
}

export async function processMinuteJob(
  job: ProcessMinuteJob,
  dependencies: MeetingWorkerDependencies
): Promise<'completed' | 'retry' | 'lost_lease'> {
  assertSharedClient(dependencies);
  const now = dependencies.now ?? (() => new Date());

  try {
    const context = MinuteContext.parse(await dependencies.reader.getMinute(job.minuteId, {
      subscriberOpenIds: job.subscriberOpenIds ?? []
    }));
    if (dependencies.context?.enabled) {
      const contextDependencies = dependencies.context;
      const captureAt = now();
      let stage: 'source' | 'enqueue' = 'source';
      try {
        const captured = captureMinuteTranscriptSource(context, captureAt, {
          maxBytes: contextDependencies.sourceMaxBytes,
          maxSegments: contextDependencies.sourceMaxSegments
        });
        dependencies.meetingRepository.client.transaction(() => {
          if (!dependencies.jobRepository.ownsLease(job, captureAt)) {
            throw new LeaseLostError(job.key);
          }
          const saved = contextDependencies.sourceRepository.saveSource(captured.source);
          stage = 'enqueue';
          dependencies.jobRepository.enqueueContextExtraction({
            sourceId: saved.source.id,
            extractorVersion: contextDependencies.extractorVersion,
            promptVersion: contextDependencies.promptVersion
          });
        })();
      } catch (error) {
        if (error instanceof LeaseLostError || isSharedDatabaseFailure(error)) throw error;
        const failureCode: ContextCaptureFailureCode = error instanceof ContextCaptureError
          ? error.code
          : stage === 'source' ? 'CONTEXT_SOURCE_CAPTURE_FAILED' : 'CONTEXT_JOB_ENQUEUE_FAILED';
        dependencies.jobRepository.recordContextFailure(job, failureCode, captureAt);
      }
    }
    const draft = parseMeetingSummaryDraft(
      await dependencies.summarizer.summarize(context)
    );
    const projectRepository = new ProjectRepository(dependencies.meetingRepository.client);
    const registry = {
      projects: projectRepository.listActiveProjects(),
      rules: projectRepository.listActiveRules(),
      contextSnapshots: []
    };
    const todos = draft.todos.map((todo) => {
      const mapping = mapTodoToProject({
        title: todo.title,
        description: todo.description,
        proposedProjectKey: todo.projectKey,
        proposedSubprojectKey: todo.subprojectKey,
        proposedConfidence: todo.projectConfidence,
        proposedEvidence: todo.projectEvidence,
        proposedProjectPrompt: todo.projectPrompt
      }, registry);
      return {
        ...todo,
        projectKey: mapping.projectKey,
        subprojectKey: mapping.subprojectKey,
        projectConfidence: mapping.confidence,
        projectEvidence: mapping.evidence,
        projectMappingStatus: mapping.status,
        projectPrompt: mapping.projectPrompt,
        mappingConflict: mapping.conflict
      };
    });
    const projectLabels = new Map(
      registry.projects.map((project) => [project.projectKey, project.displayName])
    );
    const summaryId = `summary:${job.minuteId}`;
    const meeting = {
      title: context.title,
      startedAt: context.startedAt,
      endedAt: context.endedAt
    };
    const body = renderMeetingSummary(
      {
        ...meeting,
        oneLineConclusion: draft.oneLineConclusion,
        progress: draft.progress,
        decisions: draft.decisions,
        risks: draft.risks
      },
      todos.map((todo, index) => ({
        displayedNumber: index + 1,
        title: todo.title,
        capability: todo.capability,
        projectLabel: todo.projectKey ? projectLabels.get(todo.projectKey) ?? null : null,
        projectConfidence: todo.projectConfidence,
        projectMappingStatus: todo.projectMappingStatus,
        projectConflict: todo.mappingConflict
          ? {
              existingProjectLabel: projectLabels.get(todo.mappingConflict.existingProjectKey)
                ?? todo.mappingConflict.existingProjectKey,
              candidateProjectLabel: projectLabels.get(todo.mappingConflict.candidateProjectKey)
                ?? todo.mappingConflict.candidateProjectKey
            }
          : null
      }))
    );
    const operationNow = now();

    const persisted = dependencies.meetingRepository.client.transaction(() => {
      if (!dependencies.jobRepository.ownsLease(job, operationNow)) {
        return false;
      }

      if (!dependencies.meetingRepository.findSummaryByMinute(job.minuteId)) {
        dependencies.meetingRepository.saveSummary({
          id: summaryId,
          minuteId: job.minuteId,
          summaryMessageId: `pending:minute-summary:${job.minuteId}`,
          content: JSON.stringify(draft),
          todos: todos.map((todo, index) => ({
            id: `todo:${job.minuteId}:${index + 1}`,
            displayedNumber: index + 1,
            title: todo.title,
            description: todo.description,
            risk: todo.risk,
            capability: todo.capability,
            status: 'proposed' as const,
            projectKey: todo.projectKey,
            subprojectKey: todo.subprojectKey,
            projectConfidence: todo.projectConfidence,
            projectEvidence: todo.projectEvidence,
            projectMappingStatus: todo.projectMappingStatus,
            projectPrompt: todo.projectPrompt
          }))
        });
        todos.forEach((todo, index) => {
          if (todo.mappingConflict) {
            projectRepository.recordMappingConflict({
              todoId: `todo:${job.minuteId}:${index + 1}`,
              existingProjectKey: todo.mappingConflict.existingProjectKey,
              candidateProjectKey: todo.mappingConflict.candidateProjectKey,
              evidence: todo.mappingConflict.candidateEvidence,
              createdAt: operationNow
            });
          }
        });
      }

      dependencies.outboxRepository.enqueueMeetingSummary({
        kind: 'ivy_meeting_summary',
        minuteId: job.minuteId,
        summaryId,
        targetChatId: dependencies.targetChatId,
        meeting,
        body,
        ...draft
      });
      return true;
    })();

    if (!persisted) {
      return 'lost_lease';
    }

    dependencies.jobRepository.markCompleted(job, operationNow);
    return 'completed';
  } catch (error) {
    if (error instanceof LeaseLostError) {
      return 'lost_lease';
    }

    if (error instanceof MinuteTranscriptParseError) {
      return markPermanentFailure(
        dependencies.jobRepository,
        job,
        error.code,
        now()
      );
    }

    const retriableCode = retriableErrorCode(error);
    if (retriableCode) {
      const operationNow = now();
      const attemptsForCode = job.attemptsByCode[retriableCode];
      if (attemptsForCode + 1 >= retryBudgets[retriableCode]) {
        try {
          dependencies.jobRepository.markFailed(
            job,
            `${retriableCode}_RETRY_EXHAUSTED`,
            operationNow,
            retriableCode
          );
          return 'completed';
        } catch (failure) {
          if (failure instanceof LeaseLostError) {
            return 'lost_lease';
          }
          throw failure;
        }
      }
      const retryAt = new Date(operationNow.getTime() + retryDelayMs(attemptsForCode));
      try {
        dependencies.jobRepository.markRetry(
          job,
          retriableCode,
          retryAt,
          operationNow
        );
        return 'retry';
      } catch (failure) {
        if (failure instanceof LeaseLostError) {
          return 'lost_lease';
        }
        throw failure;
      }
    }

    if (error instanceof SummarizerOutputValidationError) {
      const operationNow = now();
      return markPermanentFailure(
        dependencies.jobRepository,
        job,
        error.code,
        operationNow
      );
    }

    if (error instanceof MeetingSummaryRenderError) {
      const operationNow = now();
      return markPermanentFailure(
        dependencies.jobRepository,
        job,
        error.code,
        operationNow
      );
    }

    if (error instanceof z.ZodError) {
      const operationNow = now();
      return markPermanentFailure(
        dependencies.jobRepository,
        job,
        'MINUTE_CONTEXT_INVALID',
        operationNow
      );
    }

    throw error;
  }
}

function isSharedDatabaseFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') {
    return false;
  }
  return /^(SQLITE_(READONLY|IOERR|FULL|CANTOPEN|CORRUPT|NOTADB|BUSY|LOCKED))/.test(error.code);
}

function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, maximumRetryDelayMs);
}

function retriableErrorCode(error: unknown): RetryErrorCode | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  return error.code === 'MINUTE_NOT_READY' || error.code === 'RATE_LIMITED'
    ? error.code
    : null;
}

function markPermanentFailure(
  jobRepository: JobRepository,
  job: ProcessMinuteJob,
  reason: string,
  failedAt: Date
): 'completed' | 'lost_lease' {
  try {
    jobRepository.markFailed(job, reason, failedAt);
    return 'completed';
  } catch (error) {
    if (error instanceof LeaseLostError) {
      return 'lost_lease';
    }
    throw error;
  }
}

function assertSharedClient(dependencies: MeetingWorkerDependencies): void {
  const client = dependencies.meetingRepository.client;
  if (
    dependencies.jobRepository.client !== client ||
    dependencies.outboxRepository.client !== client
  ) {
    throw new Error('meeting worker repositories must use the same SQLite client');
  }
  if (dependencies.context?.enabled && dependencies.context.sourceRepository.client !== client) {
    throw new Error('context source repository must use the meeting worker SQLite client');
  }
}
