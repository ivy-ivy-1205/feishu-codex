import { describe, expect, it } from 'vitest';
import {
  assertSpaceSyncEnvelopeWithinLimits,
  canonicalSpacePageContentText,
  spaceCommentLogicalKey,
  spacePageLogicalKey,
  spaceSyncCoverageLogicalKey,
  spaceSyncEnvelopeV1Schema,
  spaceSyncGapLogicalKey,
  SpaceSyncEnvelopeLimitExceededError
} from '../src/domain/space-sync.js';

function validEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    syncId: 'sync_1',
    projectKey: 'smart_listing',
    trigger: 'manual',
    capturedAt: '2026-10-19T00:00:00.000Z',
    page: {
      pageId: 'page_f095a79b4bb48191b797811f8f53862d',
      spaceId: null,
      url: 'https://chatgpt.com/space/page_f095a79b4bb48191b797811f8f53862d',
      title: 'AiJia Smart Listing 与买家空间项目总览',
      sequence: 3,
      updatedAt: '2026-10-18T10:00:00.000Z',
      blocks: [
        { id: 'block_1', hash: 'a'.repeat(64), markdown: '# 项目目标' },
        { id: 'block_2', hash: 'b'.repeat(64), markdown: '当前阶段：试点' }
      ]
    },
    comments: [
      {
        threadId: 'thread_1',
        messageId: 'msg_1',
        authorId: 'user_ivy',
        authorDisplayName: 'Ivy',
        body: '这里需要修正',
        createdAt: '2026-10-18T10:05:00.000Z',
        editedAt: null,
        threadState: 'open',
        resolvedAt: null,
        targetBlockId: 'block_2',
        selectedText: '当前阶段'
      }
    ],
    coverage: { pageComplete: true, commentsComplete: true, nextCursor: null, gaps: [] },
    ...overrides
  };
}

describe('spaceSyncEnvelopeV1Schema', () => {
  it('accepts a well-formed envelope using blocks as the sole body input', () => {
    const result = spaceSyncEnvelopeV1Schema.safeParse(validEnvelope());
    expect(result.success).toBe(true);
  });

  it('rejects an envelope that also carries a legacy contentMarkdown field', () => {
    const envelope = validEnvelope();
    (envelope.page as Record<string, unknown>).contentMarkdown = '# duplicate body';
    const result = spaceSyncEnvelopeV1Schema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('rejects a resolved comment with no resolvedAt', () => {
    const envelope = validEnvelope();
    (envelope.comments as Record<string, unknown>[])[0] = {
      ...(envelope.comments as Record<string, unknown>[])[0],
      threadState: 'resolved',
      resolvedAt: null
    };
    const result = spaceSyncEnvelopeV1Schema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('rejects an open comment that carries a resolvedAt', () => {
    const envelope = validEnvelope();
    (envelope.comments as Record<string, unknown>[])[0] = {
      ...(envelope.comments as Record<string, unknown>[])[0],
      threadState: 'open',
      resolvedAt: '2026-10-18T10:06:00.000Z'
    };
    const result = spaceSyncEnvelopeV1Schema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('rejects partial coverage reported as complete gaps array missing', () => {
    const envelope = validEnvelope();
    delete (envelope.coverage as Record<string, unknown>).gaps;
    const result = spaceSyncEnvelopeV1Schema.safeParse(envelope);
    expect(result.success).toBe(false);
  });
});

describe('canonicalSpacePageContentText', () => {
  it('joins block markdown in order with a blank line between blocks', () => {
    const text = canonicalSpacePageContentText([
      { id: 'b1', hash: 'a'.repeat(64), markdown: 'first' },
      { id: 'b2', hash: 'b'.repeat(64), markdown: 'second' }
    ]);
    expect(text).toBe('first\n\nsecond');
  });
});

describe('logical key builders', () => {
  it('builds stable, distinct logical keys per concept', () => {
    expect(spacePageLogicalKey('page_1')).toBe('chatgpt_space:page:page_1');
    expect(spaceCommentLogicalKey('page_1', 'thread_1', 'msg_1'))
      .toBe('chatgpt_space:page:page_1:thread:thread_1:message:msg_1');
    expect(spaceSyncCoverageLogicalKey('page_1', 'sync_1'))
      .toBe('chatgpt_space:page:page_1:coverage:sync_1');
    expect(spaceSyncGapLogicalKey('page_1', 'sync_1', 'comments_partial'))
      .toBe('chatgpt_space:page:page_1:gap:sync_1:comments_partial');
  });
});

describe('assertSpaceSyncEnvelopeWithinLimits', () => {
  it('throws space_sync_too_many_blocks when the page exceeds the configured block limit', () => {
    const envelope = spaceSyncEnvelopeV1Schema.parse(validEnvelope());
    expect(() => assertSpaceSyncEnvelopeWithinLimits(envelope, { maxBlocks: 1, maxComments: 10 }))
      .toThrowError(SpaceSyncEnvelopeLimitExceededError);
  });

  it('throws space_sync_too_many_comments when comments exceed the configured limit', () => {
    const envelope = spaceSyncEnvelopeV1Schema.parse(validEnvelope());
    expect(() => assertSpaceSyncEnvelopeWithinLimits(envelope, { maxBlocks: 10, maxComments: 0 }))
      .toThrowError(SpaceSyncEnvelopeLimitExceededError);
  });

  it('passes when within both limits', () => {
    const envelope = spaceSyncEnvelopeV1Schema.parse(validEnvelope());
    expect(() => assertSpaceSyncEnvelopeWithinLimits(envelope, { maxBlocks: 10, maxComments: 10 }))
      .not.toThrow();
  });
});
