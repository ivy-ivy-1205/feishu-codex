import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type {
  FeishuMinuteReadOptions,
  FeishuUserAccessTokenResolver,
  MinuteContext,
  FeishuMinutesReader
} from '../ports/feishu.js';
import {
  OutboxRepository,
  type IvyMeetingSummaryMessage,
  type IvyContextReviewMessage
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
  getMinuteBasicInfo(minuteId: string, options?: FeishuApiRequestOptions): Promise<unknown>;
  exportMinuteTranscript(minuteId: string, options?: FeishuApiRequestOptions): Promise<unknown[]>;
  sendTextMessage(input: { chatId: string; text: string }): Promise<{
    messageId: string;
  }>;
  sendInteractiveMessage?(input: { chatId: string; card: Record<string, unknown> }): Promise<{
    messageId: string;
  }>;
}

export interface FeishuApiRequestOptions {
  userAccessToken?: string;
}

export interface FeishuMinutesReaderAdapterOptions {
  userAccessTokenResolver?: FeishuUserAccessTokenResolver;
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
  readonly #userAccessTokenResolver: FeishuUserAccessTokenResolver | null;

  constructor(
    private readonly client: FeishuApiClient,
    options: FeishuMinutesReaderAdapterOptions = {}
  ) {
    this.#userAccessTokenResolver = options.userAccessTokenResolver ?? null;
  }

  async getMinute(minuteId: string, options: FeishuMinuteReadOptions = {}): Promise<MinuteContext> {
    const normalizedMinuteId = minuteId.trim();
    if (!normalizedMinuteId) {
      throw new Error('minuteId is required');
    }
    const apiOptions = await this.#resolveApiOptions(options);

    const basicInfo = minuteBasicInfoSchema.parse(
      await this.client.getMinuteBasicInfo(normalizedMinuteId, apiOptions)
    );
    const transcript = (await this.client.exportMinuteTranscript(normalizedMinuteId, apiOptions))
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

  async #resolveApiOptions(options: FeishuMinuteReadOptions): Promise<FeishuApiRequestOptions | undefined> {
    if (!this.#userAccessTokenResolver) {
      return undefined;
    }
    const resolution = await this.#userAccessTokenResolver.resolveUserAccessToken({
      candidateOpenIds: normalizeOpenIds(options.subscriberOpenIds)
    });
    return resolution.status === 'available'
      ? { userAccessToken: resolution.userAccessToken }
      : undefined;
  }
}

function normalizeOpenIds(openIds: readonly string[] | undefined): string[] {
  return [...new Set((openIds ?? [])
    .map((openId) => openId.trim())
    .filter((openId) => openId.startsWith('ou_')))];
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

  async sendContextReview(message: IvyContextReviewMessage): Promise<{ messageId: string }> {
    return this.sendInteractiveCard({ chatId: message.targetChatId, card: message.card });
  }
}

export async function deliverPendingContextReviews(dependencies: {
  outboxRepository: OutboxRepository;
  delivery: FeishuMessageDeliveryAdapter;
  now?: () => Date;
  nonceFactory?: () => string;
}): Promise<{ delivered: number; retried: number }> {
  const now = dependencies.now ?? (() => new Date());
  const nonceFactory = dependencies.nonceFactory ?? (() => randomBytes(24).toString('base64url'));
  let delivered = 0;
  let retried = 0;
  const tickAt = now();
  for (const pending of dependencies.outboxRepository.listPendingContextReviewDeliveries(tickAt)) {
    let message = pending.message;
    if (!Number.isFinite(Date.parse(message.expiresAt)) || Date.parse(message.expiresAt) <= tickAt.getTime()) {
      message = dependencies.outboxRepository.refreshExpiredContextReview({
        extractionRunId: message.extractionRunId,
        cardNonce: nonceFactory(),
        expiresAt: new Date(tickAt.getTime() + 7 * 24 * 60 * 60 * 1_000)
      });
    }
    try {
      const result = await dependencies.delivery.sendContextReview(message);
      const acknowledgement = dependencies.outboxRepository.acknowledgeContextReviewDelivery({
        extractionRunId: message.extractionRunId,
        messageId: result.messageId,
        deliveredAt: tickAt
      });
      if (acknowledgement.updated) delivered += 1;
    } catch {
      dependencies.outboxRepository.markContextReviewRetry({
        extractionRunId: message.extractionRunId,
        errorCode: 'FEISHU_CONTEXT_REVIEW_DELIVERY_FAILED',
        retryAt: new Date(tickAt.getTime() + Math.min(1_000 * 2 ** pending.attemptCount, 60_000))
      });
      retried += 1;
    }
  }
  return { delivered, retried };
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
