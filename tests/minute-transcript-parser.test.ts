import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MinuteTranscriptParseError,
  parseMinuteTranscriptStream
} from '../src/adapters/minute-transcript-parser.js';

describe('parseMinuteTranscriptStream', () => {
  it('parses a JSON array stream into internal TranscriptSegment records', async () => {
    await expect(parseMinuteTranscriptStream(streamFromJson([
      {
        speakerName: ' Ivy ',
        startMs: 0,
        endMs: 12_000,
        text: ' 确认先把逐字稿解析出来 '
      },
      {
        speaker_name: 'Codex',
        start_ms: 12_000,
        end_ms: 24_000,
        text: '暂时不做总结'
      }
    ]))).resolves.toEqual([
      {
        speakerName: 'Ivy',
        startMs: 0,
        endMs: 12_000,
        text: '确认先把逐字稿解析出来'
      },
      {
        speakerName: 'Codex',
        startMs: 12_000,
        endMs: 24_000,
        text: '暂时不做总结'
      }
    ]);
  });

  it('parses wrapped transcript payloads and millisecond-like string fields', async () => {
    await expect(parseMinuteTranscriptStream(streamFromJson({
      segments: [{
        speaker: 'Ivy',
        start_time: '1000',
        end_time: '2000',
        content: '这个 parser 是为了真实飞书联调。'
      }]
    }))).resolves.toEqual([{
      speakerName: 'Ivy',
      startMs: 1_000,
      endMs: 2_000,
      text: '这个 parser 是为了真实飞书联调。'
    }]);
  });

  it('returns an empty array for an empty transcript stream', async () => {
    await expect(parseMinuteTranscriptStream(Readable.from(['[]'])))
      .resolves.toEqual([]);
  });

  it('fails closed when JSON is invalid or segment fields are unsafe', async () => {
    await expect(parseMinuteTranscriptStream(Readable.from(['not json'])))
      .rejects.toBeInstanceOf(MinuteTranscriptParseError);
    await expect(parseMinuteTranscriptStream(streamFromJson([{
      speakerName: 'Ivy',
      startMs: 3_000,
      endMs: 2_000,
      text: '时间倒挂'
    }]))).rejects.toMatchObject({
      code: 'MINUTE_TRANSCRIPT_INVALID'
    });
  });
});

function streamFromJson(value: unknown): Readable {
  return Readable.from([Buffer.from(JSON.stringify(value), 'utf8')]);
}
