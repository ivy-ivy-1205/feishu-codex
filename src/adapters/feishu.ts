import { z } from 'zod';
import type { MinuteContext, FeishuMinutesReader } from '../ports/feishu.js';
import {
  OutboxRepository,
  type IvyMeetingSummaryMessage
} from '../repositories/outbox-repository.js';

const minuteBasicInfoSchema = z.object({
  title: z.string().trim().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime()
});

const transcriptLineSchema = z.object({
  speakerName: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().trim().min(1)
}).refine((line) => line.endMs >= line.startMs, {
  message: 'endMs must be greater than or equal to startMs',
  path: ['endMs']
});

export interface FeishuApiClient {
  getMinuteBasicInfo(minuteId: string): Promise<unknown>;
  exportMinuteTranscript(minuteId: string): Promise<unknown[]>;
  sendTextMessage(input: { chatId: string; text: string }): Promise<{
    messageId: string;
  }>;
  sendInteractiveMessage?(input: { chatId: string; card: Record<string, unknown> }): Promise<{
    messageId: string;
  }>;
}

export class FeishuRetryableError extends Error {
  constructor(
    readonly code: 'MINUTE_NOT_READY' | 'RATE_LIMITED',
    message: string
  ) {
    super(message);
    this.name = 'FeishuRetryableError';
  }
}

export class FeishuMinutesReaderAdapter implements FeishuMinutesReader {
  constructor(private readonly client: FeishuApiClient) {}

  async getMinute(minuteId: string): Promise<MinuteContext> {
    const normalizedMinuteId = minuteId.trim();
    if (!normalizedMinuteId) {
      throw new Error('minuteId is required');
    }

    const basicInfo = minuteBasicInfoSchema.parse(
      await this.client.getMinuteBasicInfo(normalizedMinuteId)
    );
    const transcript = (await this.client.exportMinuteTranscript(normalizedMinuteId))
      .map((line) => transcriptLineSchema.parse(line));
    if (transcript.length === 0) {
      throw new FeishuRetryableError(
        'MINUTE_NOT_READY',
        'Feishu minute transcript is not ready'
      );
    }

    return {
      minuteId: normalizedMinuteId,
      title: basicInfo.title,
      startedAt: basicInfo.startedAt,
      endedAt: basicInfo.endedAt,
      transcript
    };
  }
}

export class FeishuMessageDeliveryAdapter {
  constructor(private readonly client: FeishuApiClient) {}

  async sendTextMessage(input: { chatId: string; text: string }): Promise<{
    messageId: string;
  }> {
    const sent = await this.client.sendTextMessage(input);
    if (!sent.messageId.trim() || sent.messageId.startsWith('pending:')) {
      throw new Error('Feishu delivery requires an actual message ID');
    }
    return { messageId: sent.messageId.trim() };
  }

  async sendInteractiveCard(input: { chatId: string; card: Record<string, unknown> }): Promise<{
    messageId: string;
  }> {
    if (!this.client.sendInteractiveMessage) {
      throw new Error('Feishu interactive card delivery is unavailable');
    }
    const sent = await this.client.sendInteractiveMessage(input);
    if (!sent.messageId.trim() || sent.messageId.startsWith('pending:')) {
      throw new Error('Feishu interactive delivery requires an actual message ID');
    }
    return { messageId: sent.messageId.trim() };
  }

  async sendMeetingSummary(message: IvyMeetingSummaryMessage): Promise<{
    messageId: string;
  }> {
    return this.sendTextMessage({
      chatId: message.targetChatId,
      text: message.body
    });
  }
}

export async function deliverPendingMeetingSummaries(dependencies: {
  outboxRepository: OutboxRepository;
  delivery: FeishuMessageDeliveryAdapter;
  now?: () => Date;
}): Promise<{ delivered: number }> {
  const now = dependencies.now ?? (() => new Date());
  let delivered = 0;
  for (const message of dependencies.outboxRepository.listPendingMeetingSummaries()) {
    const result = await dependencies.delivery.sendMeetingSummary(message);
    const acknowledgement = dependencies.outboxRepository
      .acknowledgeMeetingSummaryDelivery({
        minuteId: message.minuteId,
        messageId: result.messageId,
        deliveredAt: now()
      });
    if (acknowledgement.updated) {
      delivered += 1;
    }
  }
  return { delivered };
}
