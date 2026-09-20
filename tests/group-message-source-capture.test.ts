import { describe, expect, it } from 'vitest';
import {
  ContextCaptureError,
  ContextSourceCaptureError
} from '../src/services/context-source-capture.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

describe('captureGroupMessageSource', () => {
  it('captures one Feishu group message with stable author and thread identity', () => {
    const capturedAt = new Date('2026-09-01T00:01:00.000Z');
    const locatorUrl = 'https://applink.feishu.cn/client/message/open?chatId=oc_a84d5b6ca478220d0a37964b50776edb&messageId=om_1';
    const captured = captureGroupMessageSource({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messageId: 'om_1',
      threadId: 'omt_1',
      rootId: 'om_root',
      author: { openId: 'ou_ivy', displayName: 'Ivy' },
      messageType: 'text',
      text: '先做页面预览',
      occurredAt: '2026-09-01T00:00:00.000Z',
      locatorUrl
    }, capturedAt, { maxBytes: 1_000, maxSegments: 1 });

    expect(captured.source).toEqual({
      sourceSystem: 'feishu',
      sourceType: 'group_message',
      externalId: 'om_1',
      logicalKey: 'feishu:chat:oc_a84d5b6ca478220d0a37964b50776edb:message:om_1',
      occurredAt: '2026-09-01T00:00:00.000Z',
      authors: [{ openId: 'ou_ivy', displayName: 'Ivy' }],
      locatorUri: locatorUrl,
      contentFormat: 'text/plain',
      contentText: '先做页面预览',
      metadata: {
        chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
        messageId: 'om_1',
        threadId: 'omt_1',
        rootId: 'om_root',
        messageType: 'text',
        locatorUrl
      },
      availabilityStatus: 'available',
      capturedAt
    });
    expect(captured.messageLocator).toEqual({
      kind: 'group_message',
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messageId: 'om_1',
      threadId: 'omt_1',
      authorOpenId: 'ou_ivy',
      occurredAt: '2026-09-01T00:00:00.000Z'
    });
  });

  it('uses UTF-8 bytes and rejects oversized messages without truncating', () => {
    const message = {
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messageId: 'om_limit',
      threadId: null,
      rootId: null,
      author: { openId: null, displayName: null },
      messageType: 'text',
      text: '中',
      occurredAt: '2026-09-01T00:00:00.000Z',
      locatorUrl: null
    };

    expect(captureGroupMessageSource(message, new Date(), {
      maxBytes: 3, maxSegments: 1
    }).source.contentText).toBe('中');
    expect(() => captureGroupMessageSource(message, new Date(), {
      maxBytes: 2, maxSegments: 1
    })).toThrowError(expect.objectContaining<Partial<ContextSourceCaptureError>>({
      code: 'CONTEXT_SOURCE_BYTES_EXCEEDED'
    }));
  });

  it('rejects occurrence times that cannot become a valid evidence locator', () => {
    expect(() => captureGroupMessageSource({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messageId: 'om_bad_time',
      threadId: null,
      rootId: null,
      author: { openId: 'ou_ivy', displayName: 'Ivy' },
      messageType: 'text',
      text: '时间格式不完整',
      occurredAt: '2026-09-01'
    }, new Date())).toThrowError(expect.objectContaining<Partial<ContextCaptureError>>({
      code: 'CONTEXT_SOURCE_CAPTURE_FAILED'
    }));
  });
});
