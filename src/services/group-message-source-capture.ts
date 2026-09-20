import {
  groupMessageEvidenceLocatorSchema,
  type GroupMessageEvidenceLocator
} from '../domain/context.js';
import type { SaveContextSourceInput } from '../repositories/context-source-repository.js';
import {
  assertContextSourceBytesWithinLimit,
  ContextCaptureError,
  ContextSourceCaptureError,
  type ContextSourceCaptureLimits
} from './context-source-capture.js';

export interface GroupMessageSourceMessage {
  chatId: string;
  messageId: string;
  threadId: string | null;
  rootId: string | null;
  author: {
    openId: string | null;
    displayName: string | null;
  };
  messageType: string;
  senderType?: 'user' | 'app' | 'unknown';
  text: string;
  occurredAt: string;
  locatorUrl?: string | null;
}

export type CapturedGroupMessageLocator = Omit<
  GroupMessageEvidenceLocator,
  'sourceVersion' | 'contentHash'
>;

export interface CapturedGroupMessageSource {
  source: SaveContextSourceInput;
  messageLocator: CapturedGroupMessageLocator;
}

export function captureGroupMessageSource(
  message: GroupMessageSourceMessage,
  capturedAt: Date,
  limits?: ContextSourceCaptureLimits
): CapturedGroupMessageSource {
  if (limits && limits.maxSegments < 1) {
    throw new ContextSourceCaptureError('CONTEXT_SOURCE_SEGMENTS_EXCEEDED');
  }
  assertContextSourceBytesWithinLimit(message.text, limits);

  const chatId = requiredValue(message.chatId);
  const messageId = requiredValue(message.messageId);
  const messageType = requiredValue(message.messageType);
  const occurredAt = requiredIsoTime(message.occurredAt);
  const threadId = optionalValue(message.threadId);
  const rootId = optionalValue(message.rootId);
  const openId = optionalValue(message.author.openId);
  const displayName = optionalValue(message.author.displayName);
  const locatorUrl = optionalValue(message.locatorUrl ?? null);
  const metadata: Record<string, unknown> = {
    chatId,
    messageId,
    threadId,
    rootId,
    messageType
  };
  if (locatorUrl) metadata.locatorUrl = locatorUrl;
  if (message.senderType) metadata.senderType = message.senderType;

  return {
    source: {
      sourceSystem: 'feishu',
      sourceType: 'group_message',
      externalId: messageId,
      logicalKey: `feishu:chat:${chatId}:message:${messageId}`,
      occurredAt,
      authors: [{ openId, displayName }],
      locatorUri: locatorUrl,
      contentFormat: 'text/plain',
      contentText: message.text,
      metadata,
      availabilityStatus: 'available',
      capturedAt
    },
    messageLocator: {
      kind: 'group_message',
      chatId,
      messageId,
      threadId,
      authorOpenId: openId,
      occurredAt
    }
  };
}

function requiredValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ContextCaptureError('CONTEXT_SOURCE_CAPTURE_FAILED');
  return normalized;
}

function optionalValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function requiredIsoTime(value: string): string {
  const normalized = requiredValue(value);
  if (!groupMessageEvidenceLocatorSchema.shape.occurredAt.safeParse(normalized).success) {
    throw new ContextCaptureError('CONTEXT_SOURCE_CAPTURE_FAILED');
  }
  return normalized;
}
