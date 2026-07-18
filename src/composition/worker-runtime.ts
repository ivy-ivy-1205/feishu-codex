import type { FeishuMessageDeliveryAdapter } from '../adapters/feishu.js';
import type { FeishuMinutesReader } from '../ports/feishu.js';
import type { MeetingSummarizer } from '../ports/summarizer.js';
import { JobRepository, type DurableJob } from '../repositories/job-repository.js';
import { MeetingRepository } from '../repositories/meeting-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { DurableJobConsumer, type JobProcessResult } from '../services/job-consumer.js';
import { processMinuteJob } from '../services/meeting-worker.js';
import { deliverPendingMeetingSummaries } from '../adapters/feishu.js';

export interface DisabledWorkerRuntimeOptions {
  enabled: false;
  leaseNext?: (availableAt: Date) => DurableJob | null;
  process?: (job: DurableJob) => Promise<JobProcessResult>;
}

export interface EnabledWorkerRuntimeOptions {
  enabled: true;
  meetingRepository: MeetingRepository;
  jobRepository: JobRepository;
  outboxRepository: OutboxRepository;
  reader: FeishuMinutesReader;
  summarizer: MeetingSummarizer;
  delivery: FeishuMessageDeliveryAdapter;
  targetChatId: string;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface WorkerRuntime {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
  isConsumptionAvailable(): boolean;
}

export function createWorkerRuntime(
  options: DisabledWorkerRuntimeOptions | EnabledWorkerRuntimeOptions
): WorkerRuntime {
  if (!options.enabled) {
    return disabledWorkerRuntime;
  }

  const consumer = new DurableJobConsumer({
    intervalMs: options.intervalMs,
    now: options.now,
    onError: options.onError,
    leaseNext: (availableAt) => options.jobRepository.leaseNextProcessMinute(availableAt),
    process: async (job) => {
      const result = await processMinuteJob(job, {
        reader: options.reader,
        summarizer: options.summarizer,
        meetingRepository: options.meetingRepository,
        jobRepository: options.jobRepository,
        outboxRepository: options.outboxRepository,
        targetChatId: options.targetChatId,
        now: options.now
      });
      if (result === 'completed') {
        await deliverPendingMeetingSummaries({
          outboxRepository: options.outboxRepository,
          delivery: options.delivery,
          now: options.now
        });
      }
      return result;
    }
  });

  return consumer;
}

const disabledWorkerRuntime: WorkerRuntime = {
  start: () => undefined,
  stop: async () => undefined,
  runOnce: async () => undefined,
  isConsumptionAvailable: () => false
};
