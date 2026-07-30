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
  type DurableJob,
  type RetryErrorCode
} from '../repositories/job-repository.js';
import { MeetingRepository } from '../repositories/meeting-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import {
  MeetingSummaryRenderError,
  renderMeetingSummary
} from './summary-renderer.js';

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
}

export async function processMinuteJob(
  job: DurableJob,
  dependencies: MeetingWorkerDependencies
): Promise<'completed' | 'retry' | 'lost_lease'> {
  assertSharedClient(dependencies);
  const now = dependencies.now ?? (() => new Date());

  try {
    const context = MinuteContext.parse(await dependencies.reader.getMinute(job.minuteId, {
      subscriberOpenIds: job.subscriberOpenIds ?? []
    }));
    const draft = parseMeetingSummaryDraft(
      await dependencies.summarizer.summarize(context)
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
      draft.todos.map((todo, index) => ({
        displayedNumber: index + 1,
        title: todo.title,
        capability: todo.capability
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
          todos: draft.todos.map((todo, index) => ({
            id: `todo:${job.minuteId}:${index + 1}`,
            displayedNumber: index + 1,
            title: todo.title,
            description: todo.description,
            risk: todo.risk,
            capability: todo.capability,
            status: 'proposed' as const
          }))
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
  job: DurableJob,
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
}
