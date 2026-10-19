import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/canonical-json.js';
import { validateFounderStreamInput } from '../src/ports/founder-stream-analyzer.js';

describe('validateFounderStreamInput: Space source types', () => {
  it('accepts a space_page_snapshot source alongside existing source types', () => {
    const contentText = '当前阶段：试点';
    const input = validateFounderStreamInput({
      sources: [{
        id: 'ctxsrc_page_1', sourceType: 'space_page_snapshot', sourceVersion: 1,
        contentHash: sha256(contentText), contentText, occurredAt: '2026-10-18T10:00:00.000Z',
        availabilityStatus: 'available'
      }],
      currentTopics: []
    });
    expect(input.sources[0]?.sourceType).toBe('space_page_snapshot');
  });

  it('accepts a space_page_comment source', () => {
    const contentText = '需要补充负责人';
    const input = validateFounderStreamInput({
      sources: [{
        id: 'ctxsrc_comment_1', sourceType: 'space_page_comment', sourceVersion: 1,
        contentHash: sha256(contentText), contentText, occurredAt: '2026-10-18T10:05:00.000Z',
        availabilityStatus: 'available'
      }],
      currentTopics: []
    });
    expect(input.sources[0]?.sourceType).toBe('space_page_comment');
  });

  it('still rejects an unrecognized sourceType', () => {
    const contentText = 'x';
    expect(() => validateFounderStreamInput({
      sources: [{
        id: 'ctxsrc_1', sourceType: 'space_sync_coverage' as never, sourceVersion: 1,
        contentHash: sha256(contentText), contentText, occurredAt: '2026-10-18T10:05:00.000Z',
        availabilityStatus: 'available'
      }],
      currentTopics: []
    })).toThrow();
  });
});
