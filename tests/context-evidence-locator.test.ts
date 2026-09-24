import { describe, expect, it } from 'vitest';
import {
  validateContextEvidenceLocator,
  validateTranscriptEvidenceLocator
} from '../src/services/context-evidence-locator.js';

const contentHash = 'a'.repeat(64);
const groupSource = {
  sourceVersion: 1,
  contentHash,
  sourceType: 'group_message',
  externalId: 'om_1',
  occurredAt: '2026-09-01T00:00:00.000Z',
  authors: [{ openId: 'ou_ivy', displayName: 'Ivy' }],
  contentText: '先做页面预览',
  metadata: {
    chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
    messageId: 'om_1',
    threadId: 'omt_1',
    rootId: 'om_root',
    messageType: 'text'
  }
};
const groupLocator = {
  kind: 'group_message' as const,
  sourceVersion: 1,
  contentHash,
  chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
  messageId: 'om_1',
  threadId: 'omt_1',
  authorOpenId: 'ou_ivy',
  occurredAt: '2026-09-01T00:00:00.000Z'
};

describe('context evidence locators', () => {
  it('keeps the legacy minute locator input valid while the unified result is discriminated', () => {
    const source = {
      sourceVersion: 1,
      contentHash,
      contentText: 'Ivy [0-1000]: 先做页面预览',
      metadata: {
        segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1000,
          text: '先做页面预览' }]
      }
    };
    const legacyLocator = {
      segmentOrdinal: 0,
      sourceVersion: 1,
      contentHash,
      speakerName: 'Ivy',
      startMs: 0,
      endMs: 1000
    };

    expect(validateTranscriptEvidenceLocator(source, '先做页面预览', legacyLocator))
      .toEqual(legacyLocator);
    expect(validateContextEvidenceLocator(source, '先做页面预览', legacyLocator))
      .toEqual({ kind: 'minute_segment', ...legacyLocator });
  });

  it('accepts a group-message locator bound to the stored immutable source', () => {
    expect(validateContextEvidenceLocator(groupSource, '页面预览', groupLocator)).toEqual(groupLocator);
  });

  it('accepts the legacy attachment source/message identity split only for a bound attachment source', () => {
    const source = { ...groupSource, externalId: 'om_1:file:abc123',
      metadata: { ...groupSource.metadata, attachmentTitle: 'brief.docx' } };
    const locator = { ...groupLocator, messageId: source.externalId };

    expect(validateContextEvidenceLocator(source, '页面预览', locator)).toEqual(locator);
    expect(() => validateContextEvidenceLocator({ ...source, externalId: 'unrelated' }, '页面预览', locator))
      .toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });

  it.each([
    ['source version', { sourceVersion: 2 }],
    ['content hash', { contentHash: 'f'.repeat(64) }],
    ['chat id', { chatId: 'oc_other' }],
    ['message id', { messageId: 'om_other' }],
    ['thread id', { threadId: 'omt_other' }],
    ['author', { authorOpenId: 'ou_james' }],
    ['occurrence time', { occurredAt: '2026-09-01T00:00:01.000Z' }]
  ])('rejects group evidence with a mismatched %s', (_label, override) => {
    expect(() => validateContextEvidenceLocator(groupSource, '页面预览', {
      ...groupLocator,
      ...override
    })).toThrow();
  });

  it('rejects a group excerpt that is absent from the stored message', () => {
    expect(() => validateContextEvidenceLocator(groupSource, '不在原文里', groupLocator))
      .toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });
});
