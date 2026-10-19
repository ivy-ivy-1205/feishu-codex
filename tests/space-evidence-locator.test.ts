import { describe, expect, it } from 'vitest';
import { validateContextEvidenceLocator } from '../src/services/context-evidence-locator.js';
import { sha256 } from '../src/services/canonical-json.js';

const pageContentHash = sha256('page-content');
const commentContentHash = sha256('comment-content');

function pageSource(overrides: Partial<Record<string, unknown>> = {}) {
  const blockOneMarkdown = '# 项目目标\n当前阶段：试点';
  const blockTwoMarkdown = '下一步：Ivy review';
  return {
    sourceType: 'space_page_snapshot',
    sourceVersion: 1,
    contentHash: pageContentHash,
    contentText: `${blockOneMarkdown}\n\n${blockTwoMarkdown}`,
    metadata: {
      pageId: 'page_1',
      blocks: [
        { id: 'block_1', hash: sha256(blockOneMarkdown), markdown: blockOneMarkdown },
        { id: 'block_2', hash: sha256(blockTwoMarkdown), markdown: blockTwoMarkdown }
      ]
    },
    ...overrides
  };
}

function commentSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sourceType: 'space_page_comment',
    sourceVersion: 1,
    contentHash: commentContentHash,
    contentText: '这里需要修正阶段描述',
    metadata: {
      pageId: 'page_1',
      threadId: 'thread_1',
      messageId: 'msg_1',
      authorOpenId: 'ou_ivy',
      targetBlockId: 'block_1'
    },
    ...overrides
  };
}

describe('validateContextEvidenceLocator: space_page_block', () => {
  it('accepts an excerpt that is contained in the referenced block', () => {
    const source = pageSource();
    const locator = validateContextEvidenceLocator(source, '当前阶段：试点', {
      kind: 'space_page_block', sourceVersion: 1, contentHash: pageContentHash,
      pageId: 'page_1', blockId: 'block_1',
      blockHash: (source.metadata.blocks[0] as { hash: string }).hash, blockOrdinal: 0
    });
    expect(locator.kind).toBe('space_page_block');
  });

  it('rejects an excerpt that only appears in a different block (cross-block grounding)', () => {
    const source = pageSource();
    expect(() => validateContextEvidenceLocator(source, 'Ivy review', {
      kind: 'space_page_block', sourceVersion: 1, contentHash: pageContentHash,
      pageId: 'page_1', blockId: 'block_1',
      blockHash: (source.metadata.blocks[0] as { hash: string }).hash, blockOrdinal: 0
    })).toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });

  it('rejects a locator whose sourceVersion does not match the stored source', () => {
    const source = pageSource();
    expect(() => validateContextEvidenceLocator(source, '当前阶段：试点', {
      kind: 'space_page_block', sourceVersion: 2, contentHash: pageContentHash,
      pageId: 'page_1', blockId: 'block_1',
      blockHash: (source.metadata.blocks[0] as { hash: string }).hash, blockOrdinal: 0
    })).toThrow('CONTEXT_EVIDENCE_SOURCE_BINDING_INVALID');
  });

  it('rejects a block hash that does not match the stored block (tamper detection)', () => {
    const source = pageSource();
    expect(() => validateContextEvidenceLocator(source, '当前阶段：试点', {
      kind: 'space_page_block', sourceVersion: 1, contentHash: pageContentHash,
      pageId: 'page_1', blockId: 'block_1', blockHash: 'f'.repeat(64), blockOrdinal: 0
    })).toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });

  it('rejects when the source is not actually a space_page_snapshot', () => {
    const source = pageSource({ sourceType: 'group_message' });
    expect(() => validateContextEvidenceLocator(source, '当前阶段：试点', {
      kind: 'space_page_block', sourceVersion: 1, contentHash: pageContentHash,
      pageId: 'page_1', blockId: 'block_1',
      blockHash: (source.metadata.blocks[0] as { hash: string }).hash, blockOrdinal: 0
    })).toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });
});

describe('validateContextEvidenceLocator: space_comment', () => {
  it('accepts an excerpt contained in the comment body with matching author and target block', () => {
    const source = commentSource();
    const locator = validateContextEvidenceLocator(source, '需要修正阶段描述', {
      kind: 'space_comment', sourceVersion: 1, contentHash: commentContentHash,
      pageId: 'page_1', threadId: 'thread_1', messageId: 'msg_1',
      authorOpenId: 'ou_ivy', targetBlockId: 'block_1'
    });
    expect(locator.kind).toBe('space_comment');
  });

  it('rejects an authorOpenId mismatch (comments must not be merged across authors)', () => {
    const source = commentSource();
    expect(() => validateContextEvidenceLocator(source, '需要修正阶段描述', {
      kind: 'space_comment', sourceVersion: 1, contentHash: commentContentHash,
      pageId: 'page_1', threadId: 'thread_1', messageId: 'msg_1',
      authorOpenId: 'ou_james', targetBlockId: 'block_1'
    })).toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });

  it('rejects an excerpt not present in the comment body', () => {
    const source = commentSource();
    expect(() => validateContextEvidenceLocator(source, '不存在的句子', {
      kind: 'space_comment', sourceVersion: 1, contentHash: commentContentHash,
      pageId: 'page_1', threadId: 'thread_1', messageId: 'msg_1',
      authorOpenId: 'ou_ivy', targetBlockId: 'block_1'
    })).toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });

  it('rejects a thread/message id mismatch', () => {
    const source = commentSource();
    expect(() => validateContextEvidenceLocator(source, '需要修正阶段描述', {
      kind: 'space_comment', sourceVersion: 1, contentHash: commentContentHash,
      pageId: 'page_1', threadId: 'thread_1', messageId: 'msg_other',
      authorOpenId: 'ou_ivy', targetBlockId: 'block_1'
    })).toThrow('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  });
});
