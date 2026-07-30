import { describe, expect, it } from 'vitest';
import { FeishuMessageDeliveryAdapter } from '../src/adapters/feishu.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createWorkerRuntime } from '../src/composition/worker-runtime.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import type { FeishuMinutesReader } from '../src/ports/feishu.js';
import type { MeetingSummarizer } from '../src/ports/summarizer.js';

describe('createWorkerRuntime', () => {
  it('keeps the production worker disabled by default', async () => {
    let leased = false;
    const runtime = createWorkerRuntime({
      enabled: false,
      leaseNext: () => {
        leased = true;
        return null;
      },
      process: async () => 'completed'
    });

    runtime.start();
    await runtime.runOnce();

    expect(runtime.isConsumptionAvailable()).toBe(false);
    expect(leased).toBe(false);
    await runtime.stop();
  });

  it('wires one enabled worker cycle through Feishu reader, summarizer, and delivery', async () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const meetingRepository = new MeetingRepository(database.client);
    const jobRepository = new JobRepository(database.client, { leaseDurationMs: 180_000 });
    const outboxRepository = new OutboxRepository(database.client);
    meetingRepository.ingestMinute({
      minuteId: 'min_runtime_1',
      eventId: 'evt_runtime_1'
    });
    jobRepository.enqueueProcessMinute('min_runtime_1');
    const errors: unknown[] = [];

    const runtime = createWorkerRuntime({
      enabled: true,
      intervalMs: 1_000,
      meetingRepository,
      jobRepository,
      outboxRepository,
      targetChatId: 'oc_d851c3e986007dc0f97ab582bcb2e7c8',
      reader: fakeReader(),
      summarizer: fakeSummarizer(),
      onError: (error) => errors.push(error),
      delivery: new FeishuMessageDeliveryAdapter({
        getMinuteBasicInfo: async () => ({}),
        exportMinuteTranscript: async () => [],
        sendTextMessage: async () => ({ messageId: 'om_runtime_summary_1' })
      })
    });

    runtime.start();
    await runtime.runOnce();

    expect(errors).toEqual([]);
    expect(runtime.isConsumptionAvailable()).toBe(true);
    expect(meetingRepository.findSummaryByMinute('min_runtime_1'))
      .toMatchObject({ summaryMessageId: 'om_runtime_summary_1' });
    expect(outboxRepository.listPendingMeetingSummaries()).toEqual([]);
    await runtime.stop();
    expect(runtime.isConsumptionAvailable()).toBe(false);
    database.close();
  });
});

function fakeReader(): FeishuMinutesReader {
  return {
    async getMinute(minuteId) {
      return {
        minuteId,
        title: 'AI Native 周会',
        startedAt: '2026-07-18T02:00:00.000Z',
        endedAt: '2026-07-18T02:30:00.000Z',
        transcript: [{
          speakerName: 'Ivy',
          startMs: 0,
          endMs: 1_000,
          text: '请整理会后事项。'
        }]
      };
    }
  };
}

function fakeSummarizer(): MeetingSummarizer {
  return {
    async summarize() {
      return {
        oneLineConclusion: '会议需要形成可执行的会后推进事项。',
        progress: ['会议需要形成可执行的会后推进事项。'],
        decisions: [],
        risks: [],
        todos: [{
          title: '整理会后事项',
          description: '输出一版可直接发给 Ivy 的行动清单。',
          risk: 'low',
          capability: 'content_draft'
        }]
      };
    }
  };
}
