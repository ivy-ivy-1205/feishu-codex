import { describe, expect, it } from 'vitest';
import {
  captureMinuteTranscriptSource,
  ContextSourceCaptureError
} from '../src/services/context-source-capture.js';

describe('captureMinuteTranscriptSource', () => {
  it('normalizes every transcript segment with stable ordinal locators', () => {
    const captured = captureMinuteTranscriptSource({
      minuteId: 'min-1', title: 'Phase 1E',
      startedAt: '2026-08-03T01:00:00.000Z', endedAt: '2026-08-03T02:00:00.000Z',
      transcript: [
        { speakerName: 'James', startMs: 0, endMs: 1000, text: '第一行\n第二行' },
        { speakerName: 'Ivy', startMs: 1001, endMs: 2000, text: '后续决定' }
      ]
    }, new Date('2026-08-03T03:00:00.000Z'));

    expect(captured.source).toMatchObject({
      sourceSystem: 'feishu', sourceType: 'minute_transcript', externalId: 'min-1',
      logicalKey: 'feishu:minute:min-1:transcript', contentFormat: 'text/plain; profile=normalized-transcript-v1',
      contentText: 'James [0-1000]: 第一行\n第二行\nIvy [1001-2000]: 后续决定'
    });
    expect(captured.segmentLocators).toEqual([
      { segmentOrdinal: 0, speakerName: 'James', startMs: 0, endMs: 1000, text: '第一行\n第二行' },
      { segmentOrdinal: 1, speakerName: 'Ivy', startMs: 1001, endMs: 2000, text: '后续决定' }
    ]);
    expect(captured.source.metadata).toMatchObject({
      title: 'Phase 1E',
      normalizationVersion: 'normalized-transcript-v1',
      segments: [
        { segmentOrdinal: 0, speakerName: 'James', startMs: 0, endMs: 1000, text: '第一行\n第二行' },
        { segmentOrdinal: 1, speakerName: 'Ivy', startMs: 1001, endMs: 2000, text: '后续决定' }
      ]
    });
  });

  it('uses UTF-8 bytes and rejects oversized sources without truncating', () => {
    const context = {
      minuteId: 'min-limit', title: '中文边界',
      startedAt: '2026-08-03T01:00:00.000Z', endedAt: '2026-08-03T02:00:00.000Z',
      transcript: [{ speakerName: 'Ivy', startMs: 0, endMs: 1, text: '中' }]
    };
    const normalized = 'Ivy [0-1]: 中';
    expect(Buffer.byteLength(normalized, 'utf8')).toBe(14);
    expect(captureMinuteTranscriptSource(context, new Date(), {
      maxBytes: 14, maxSegments: 1
    }).source.contentText).toBe(normalized);
    expect(() => captureMinuteTranscriptSource(context, new Date(), {
      maxBytes: 13, maxSegments: 1
    })).toThrowError(expect.objectContaining<Partial<ContextSourceCaptureError>>({
      code: 'CONTEXT_SOURCE_BYTES_EXCEEDED'
    }));
    expect(() => captureMinuteTranscriptSource({
      ...context,
      transcript: [...context.transcript, { speakerName: 'Ivy', startMs: 2, endMs: 3, text: '二' }]
    }, new Date(), { maxBytes: 1_000, maxSegments: 1 })).toThrowError(
      expect.objectContaining<Partial<ContextSourceCaptureError>>({
        code: 'CONTEXT_SOURCE_SEGMENTS_EXCEEDED'
      })
    );
  });
});
