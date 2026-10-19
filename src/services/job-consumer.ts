import type { DurableJob } from '../repositories/job-repository.js';

export type JobProcessResult = 'completed' | 'retry' | 'lost_lease';

export interface DurableJobConsumerDependencies {
  leaseNext(availableAt: Date): DurableJob | null;
  process(job: DurableJob): Promise<JobProcessResult>;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  afterTick?: () => Promise<void>;
}

export class DurableJobConsumer {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timeout: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;

  constructor(private readonly dependencies: DurableJobConsumerDependencies) {
    this.intervalMs = dependencies.intervalMs ?? 1_000;
    this.now = dependencies.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('intervalMs must be a positive safe integer');
    }
  }

  isConsumptionAvailable(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      const job = this.dependencies.leaseNext(this.now());
      if (job) {
        await this.dependencies.process(job);
      }
      await this.dependencies.afterTick?.();
    } catch (error) {
      this.dependencies.onError?.(error);
    } finally {
      this.processing = false;
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.timeout = setTimeout(() => {
      void this.runOnce().finally(() => this.scheduleNext());
    }, this.intervalMs);
  }
}
