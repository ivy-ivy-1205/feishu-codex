import type { FeishuMessageDeliveryAdapter } from '../adapters/feishu.js';
import type { FeishuMinutesReader } from '../ports/feishu.js';
import type { MeetingSummarizer } from '../ports/summarizer.js';
import { JobRepository, type DurableJob } from '../repositories/job-repository.js';
import { MeetingRepository } from '../repositories/meeting-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { DurableJobConsumer, type JobProcessResult } from '../services/job-consumer.js';
import { processMinuteJob } from '../services/meeting-worker.js';
import { deliverPendingContextReviews, deliverPendingMeetingSummaries } from '../adapters/feishu.js';
import { processContextCandidateJob, type ContextCandidateWorkerDependencies } from '../services/context-candidate-worker.js';
import type { MeetingWorkerDependencies } from '../services/meeting-worker.js';
import type { createFounderStreamRuntime } from '../services/founder-stream-worker.js';

export interface DisabledWorkerRuntimeOptions {
  enabled: false;
  leaseNext?: (availableAt: Date) => DurableJob | null;
  process?: (job: DurableJob) => Promise<JobProcessResult>;
}

export interface EnabledWorkerRuntimeOptions {
  founder?: ReturnType<typeof createFounderStreamRuntime>;
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
  context?: {
    capture: NonNullable<MeetingWorkerDependencies['context']>;
    worker: ContextCandidateWorkerDependencies;
  };
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
    afterTick: async () => {
      if (options.context) await deliverPendingContextReviews({ outboxRepository: options.outboxRepository,
        delivery: options.delivery, now: options.now });
      await options.founder?.afterTick();
    },
    leaseNext: (availableAt) => options.jobRepository.leaseNextSupportedJob(
      availableAt,
      [...(options.context ? ['process_minute', 'extract_context_candidates'] as const : ['process_minute'] as const),
        ...(options.founder?.supportedKinds ?? [])]
    ),
    process: async (job) => {
      // Must list every kind in founder.supportedKinds: a kind leased above but missing here is
      // rejected as unsupported and re-leased forever (the Space batch was, until 2026-10-21).
      if (job.kind === 'capture_group_message' || job.kind === 'capture_founder_attachment' || job.kind === 'analyze_founder_stream_batch' ||
        job.kind === 'analyze_founder_stream_space_batch') {
        if (!options.founder) throw new Error('Founder job leased without runtime');
        return options.founder.process(job);
      }
      if (job.kind === 'extract_context_candidates') {
        if (!options.context) throw new Error('Context job was leased without Context runtime');
        return processContextCandidateJob(job, options.context.worker);
      }
      if (job.kind !== 'process_minute') throw new Error('Unsupported job');
      const result = await processMinuteJob(job, {
        reader: options.reader,
        summarizer: options.summarizer,
        meetingRepository: options.meetingRepository,
        jobRepository: options.jobRepository,
        outboxRepository: options.outboxRepository,
        targetChatId: options.targetChatId,
        now: options.now,
        founder: options.founder,
        context: options.context?.capture ?? { enabled: false }
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

  return {
    start(){options.founder?.startManualQueries();consumer.start();},
    async stop(){await consumer.stop();await options.founder?.stopManualQueries();},
    async runOnce(){await Promise.all([consumer.runOnce(),options.founder?.runManualQueriesOnce()]);},
    isConsumptionAvailable(){return consumer.isConsumptionAvailable();}
  };
}

const disabledWorkerRuntime: WorkerRuntime = {
  start: () => undefined,
  stop: async () => undefined,
  runOnce: async () => undefined,
  isConsumptionAvailable: () => false
};
