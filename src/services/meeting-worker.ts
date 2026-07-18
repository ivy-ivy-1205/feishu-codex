import { z } from 'zod';
import { MinuteContext, type FeishuMinutesReader } from '../ports/feishu.js';
import {
  MeetingSummaryDraft,
  type MeetingSummarizer
} from '../ports/summarizer.js';
import { JobRepository, type DurableJob } from '../repositories/job-repository.js';
import { MeetingRepository } from '../repositories/meeting-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';

const maximumRetryDelayMs = 60_000;

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
): Promise<'completed' | 'retry'> {
  assertSharedClient(dependencies);
  const now = dependencies.now ?? (() => new Date());

  try {
    const context = MinuteContext.parse(await dependencies.reader.getMinute(job.minuteId));
    const draft = MeetingSummaryDraft.parse(await dependencies.summarizer.summarize(context));
    const summaryId = `summary:${job.minuteId}`;

    const persisted = dependencies.meetingRepository.client.transaction(() => {
      if (!dependencies.jobRepository.ownsLease(job)) {
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
            status: 'proposed' as const
          }))
        });
      }

      dependencies.outboxRepository.enqueueMeetingSummary({
        kind: 'ivy_meeting_summary',
        minuteId: job.minuteId,
        summaryId,
        targetChatId: dependencies.targetChatId,
        ...draft
      });
      return true;
    })();

    if (!persisted) {
      return 'completed';
    }

    dependencies.jobRepository.markCompleted(job, now());
    return 'completed';
  } catch (error) {
    if (isRetriable(error)) {
      const retryAt = new Date(now().getTime() + retryDelayMs(job.attempt));
      dependencies.jobRepository.markRetry(job, retryAt);
      return 'retry';
    }

    if (error instanceof z.ZodError) {
      dependencies.jobRepository.markFailed(
        job,
        'SUMMARIZER_OUTPUT_INVALID',
        now()
      );
      return 'completed';
    }

    throw error;
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, maximumRetryDelayMs);
}

function isRetriable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return error.code === 'MINUTE_NOT_READY' || error.code === 'RATE_LIMITED';
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
