import { describe, expect, it, vi } from 'vitest';
import type { DurableJob } from '../src/repositories/job-repository.js';
import { DurableJobConsumer } from '../src/services/job-consumer.js';

const job: DurableJob = {
  kind: 'process_minute',
  key: 'minute:test_minute',
  minuteId: 'test_minute',
  attemptsByCode: {
    MINUTE_NOT_READY: 0,
    RATE_LIMITED: 0
  },
  leaseExpiresAt: '2030-07-18T03:03:00.000Z'
};

describe('DurableJobConsumer', () => {
  it('reports unavailable before start and available after start', async () => {
    const consumer = new DurableJobConsumer({
      leaseNext: () => null,
      process: async () => 'completed',
      intervalMs: 60_000
    });

    expect(consumer.isConsumptionAvailable()).toBe(false);

    consumer.start();

    expect(consumer.isConsumptionAvailable()).toBe(true);
    await consumer.stop();
    expect(consumer.isConsumptionAvailable()).toBe(false);
  });

  it('leases one available process_minute job and hands it to the processor', async () => {
    const processed: DurableJob[] = [];
    const consumer = new DurableJobConsumer({
      leaseNext: () => job,
      process: async (leasedJob) => {
        processed.push(leasedJob);
        return 'completed';
      },
      intervalMs: 60_000
    });

    await consumer.runOnce();

    expect(processed).toEqual([job]);
  });

  it('does not run overlapping ticks while a previous processor call is still active', async () => {
    let finishProcessing!: () => void;
    const process = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishProcessing = resolve;
      });
      return 'completed' as const;
    });
    const consumer = new DurableJobConsumer({
      leaseNext: () => job,
      process,
      intervalMs: 60_000
    });

    const first = consumer.runOnce();
    await consumer.runOnce();

    expect(process).toHaveBeenCalledTimes(1);
    finishProcessing();
    await first;
  });

  it('runs an independent after-tick drain even when there is no job', async () => {
    let drains = 0;
    const consumer = new DurableJobConsumer({ leaseNext: () => null,
      process: async () => 'completed', afterTick: async () => { drains += 1; } });
    await consumer.runOnce();
    await consumer.runOnce();
    expect(drains).toBe(2);
  });
});
