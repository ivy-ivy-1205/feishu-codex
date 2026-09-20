import { describe, expect, it } from 'vitest';
import {
  FeishuMinutesReaderAdapter,
  FeishuMessageDeliveryAdapter,
  deliverPendingMeetingSummaries,
  type FeishuApiClient
} from '../src/adapters/feishu.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import type { IvyMeetingSummaryMessage } from '../src/repositories/outbox-repository.js';
import { renderFounderWorkMap } from '../src/services/founder-work-map-renderer.js';

const summaryMessage: IvyMeetingSummaryMessage = {
  kind: 'ivy_meeting_summary',
  minuteId: 'min_real_1',
  summaryId: 'summary:min_real_1',
  targetChatId: 'oc_d851c3e986007dc0f97ab582bcb2e7c8',
  meeting: {
    title: 'AI Native 周会',
    startedAt: '2026-07-18T02:00:00.000Z',
    endedAt: '2026-07-18T02:30:00.000Z'
  },
  body: '会议总结正文',
  oneLineConclusion: '讨论 Context OS 的飞书入口。',
  progress: ['讨论 Context OS 的飞书入口'],
  decisions: [],
  risks: [],
  todos: []
};

describe('Feishu real adapter boundary', () => {
  it('delivers founder cards through interactive delivery without exposing routing metadata', async () => {
    const sentCards: Array<{ chatId: string; card: Record<string, unknown> }> = [];
    const delivery = new FeishuMessageDeliveryAdapter(createClient({ sentCards, messageId: 'om_founder' }));
    const rendered = renderFounderWorkMap({ since: '2026-08-31T00:00:00.000Z', until: '2026-09-20T00:00:00.000Z',
      topics: [], uncertainGrouping: [], coverageGaps: [] })[0]!;
    await expect(delivery.sendFounderCard({ ...rendered, targetChatId: 'oc_founders' })).resolves.toEqual({ messageId: 'om_founder' });
    expect(sentCards).toEqual([{ chatId: 'oc_founders', card: rendered.card }]);
    expect(JSON.stringify(sentCards[0]!.card)).not.toContain('itemRefs');
  });

  it('normalizes Feishu minute basic info and transcript into MinuteContext', async () => {
    const reader = new FeishuMinutesReaderAdapter(createClient({
      minute: {
        title: ' AI Native 周会 ',
        startedAt: '2026-07-18T02:00:00.000Z',
        endedAt: '2026-07-18T02:30:00.000Z'
      },
      transcript: [
        {
          speakerName: ' Ivy ',
          startMs: 0,
          endMs: 12_000,
          text: ' 确认飞书作为入口 '
        },
        {
          speakerName: 'Codex',
          startMs: 12_000,
          endMs: 20_000,
          text: '生成 Todo 但不自动执行'
        }
      ]
    }));

    await expect(reader.getMinute(' min_real_1 ')).resolves.toEqual({
      minuteId: 'min_real_1',
      title: 'AI Native 周会',
      startedAt: '2026-07-18T02:00:00.000Z',
      endedAt: '2026-07-18T02:30:00.000Z',
      transcript: [
        {
          speakerName: 'Ivy',
          startMs: 0,
          endMs: 12_000,
          text: '确认飞书作为入口'
        },
        {
          speakerName: 'Codex',
          startMs: 12_000,
          endMs: 20_000,
          text: '生成 Todo 但不自动执行'
        }
      ]
    });
  });

  it('maps missing transcript to MINUTE_NOT_READY for durable retry', async () => {
    const reader = new FeishuMinutesReaderAdapter(createClient({
      minute: {
        title: 'AI Native 周会',
        startedAt: '2026-07-18T02:00:00.000Z',
        endedAt: '2026-07-18T02:30:00.000Z'
      },
      transcript: []
    }));

    await expect(reader.getMinute('min_real_1')).rejects.toMatchObject({
      code: 'MINUTE_NOT_READY'
    });
  });

  it('uses the matching OAuth user token for minute reads', async () => {
    const calls: unknown[] = [];
    const reader = new FeishuMinutesReaderAdapter(createClient({
      minute: {
        title: 'Ivy 的自动妙记',
        startedAt: '2026-07-30T07:00:00.000Z',
        endedAt: '2026-07-30T07:05:00.000Z'
      },
      transcript: [{
        speakerName: 'Ivy',
        startMs: 0,
        endMs: 1_000,
        text: '以后不要每次手动改妙记权限。'
      }],
      calls
    }), {
      userAccessTokenResolver: {
        async resolveUserAccessToken(input) {
          return {
            status: 'available',
            openId: input.candidateOpenIds[0]!,
            userAccessToken: 'u-ivy-minute-token'
          };
        }
      }
    });

    await expect(reader.getMinute('min_real_1', {
      subscriberOpenIds: ['ou_ivy_fixture']
    })).resolves.toMatchObject({
      minuteId: 'min_real_1',
      title: 'Ivy 的自动妙记'
    });

    expect(calls).toEqual([
      {
        method: 'getMinuteBasicInfo',
        minuteId: 'min_real_1',
        options: { userAccessToken: 'u-ivy-minute-token' }
      },
      {
        method: 'exportMinuteTranscript',
        minuteId: 'min_real_1',
        options: { userAccessToken: 'u-ivy-minute-token' }
      }
    ]);
  });

  it('sends meeting summary text to the target chat and returns the real message ID', async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const delivery = new FeishuMessageDeliveryAdapter(createClient({
      sent,
      messageId: 'om_real_summary_1'
    }));

    await expect(delivery.sendMeetingSummary(summaryMessage)).resolves.toEqual({
      messageId: 'om_real_summary_1'
    });
    expect(sent).toEqual([{
      chatId: summaryMessage.targetChatId,
      text: summaryMessage.body
    }]);
  });

  it('sends direct text messages to a chat with the same message ID safety check', async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const delivery = new FeishuMessageDeliveryAdapter(createClient({
      sent,
      messageId: 'om_direct_ack_1'
    }));

    await expect(delivery.sendTextMessage({
      chatId: 'oc_private_chat',
      text: '我已收到。'
    })).resolves.toEqual({ messageId: 'om_direct_ack_1' });
    expect(sent).toEqual([{
      chatId: 'oc_private_chat',
      text: '我已收到。'
    }]);
  });

  it('sends interactive cards to a chat with the same message ID safety check', async () => {
    const sentCards: Array<{ chatId: string; card: Record<string, unknown> }> = [];
    const delivery = new FeishuMessageDeliveryAdapter(createClient({
      sentCards,
      messageId: 'om_direct_card_1'
    }));
    const card = { elements: [] };

    await expect(delivery.sendInteractiveCard({
      chatId: 'oc_private_chat',
      card
    })).resolves.toEqual({ messageId: 'om_direct_card_1' });
    expect(sentCards).toEqual([{
      chatId: 'oc_private_chat',
      card
    }]);
  });

  it('fails closed when interactive card delivery is unavailable', async () => {
    const delivery = new FeishuMessageDeliveryAdapter(createClient({
      messageId: 'om_direct_card_1'
    }));

    await expect(delivery.sendInteractiveCard({
      chatId: 'oc_private_chat',
      card: { elements: [] }
    })).rejects.toThrow(/interactive card delivery is unavailable/i);
  });

  it('delivers pending meeting summaries and acknowledges them with real Feishu message IDs', async () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const meetingRepository = new MeetingRepository(database.client);
    const outboxRepository = new OutboxRepository(database.client);
    meetingRepository.ingestMinute({ minuteId: 'min_real_1', eventId: 'evt_real_1' });
    meetingRepository.saveSummary({
      id: 'summary:min_real_1',
      minuteId: 'min_real_1',
      summaryMessageId: 'pending:minute-summary:min_real_1',
      content: JSON.stringify({ progress: ['待投递'] }),
      todos: [{
        id: 'todo:min_real_1:1',
        displayedNumber: 1,
        title: '整理上下文',
        description: '整理会议上下文',
        risk: 'low',
        capability: 'content_draft',
        status: 'proposed'
      }]
    });
    outboxRepository.enqueueMeetingSummary(summaryMessage);
    const delivery = new FeishuMessageDeliveryAdapter(createClient({
      messageId: 'om_real_summary_1'
    }));

    await expect(deliverPendingMeetingSummaries({
      outboxRepository,
      delivery,
      now: () => new Date('2030-07-18T04:00:00.000Z')
    })).resolves.toEqual({ delivered: 1 });

    expect(meetingRepository.findTodoByReply('om_real_summary_1', 1)?.id)
      .toBe('todo:min_real_1:1');
  });
});

function createClient(options: {
  minute?: unknown;
  transcript?: unknown[];
  calls?: unknown[];
  sent?: Array<{ chatId: string; text: string }>;
  sentCards?: Array<{ chatId: string; card: Record<string, unknown> }>;
  messageId?: string;
}): FeishuApiClient {
  return {
    async getMinuteBasicInfo(minuteId, requestOptions) {
      options.calls?.push({
        method: 'getMinuteBasicInfo',
        minuteId,
        ...(requestOptions ? { options: requestOptions } : {})
      });
      return options.minute ?? null;
    },
    async exportMinuteTranscript(minuteId, requestOptions) {
      options.calls?.push({
        method: 'exportMinuteTranscript',
        minuteId,
        ...(requestOptions ? { options: requestOptions } : {})
      });
      return options.transcript ?? [];
    },
    async sendTextMessage(input) {
      options.sent?.push(input);
      return { messageId: options.messageId ?? 'om_test_message' };
    },
    async sendInteractiveMessage(input) {
      if (!options.sentCards) {
        throw new Error('interactive card delivery is unavailable');
      }
      options.sentCards.push(input);
      return { messageId: options.messageId ?? 'om_test_message' };
    }
  };
}
