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

  it('parses Feishu plain text transcript exports into ordered text segments', async () => {
    const plainText = [
      '2026-07-03 20:04:28 CST|Ivy的视频会议',
      '',
      '发言人（2）:',
      'Ivy、james wang',
      '',
      'Ivy',
      '我们先确认 landing page 的参考素材和整体方向。',
      '',
      'james wang',
      'Landbook 可以作为页面结构参考，Motion Sizes 可以作为 hero 区参考。',
      '下一步整理成前端实现清单。',
      '',
      'Ivy',
      '好的，先把可以推进的事项列出来。'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .resolves.toEqual([
        {
          speakerName: 'Ivy',
          startMs: 0,
          endMs: 1,
          text: '我们先确认 landing page 的参考素材和整体方向。'
        },
        {
          speakerName: 'james wang',
          startMs: 1,
          endMs: 2,
          text: 'Landbook 可以作为页面结构参考，Motion Sizes 可以作为 hero 区参考。\n下一步整理成前端实现清单。'
        },
        {
          speakerName: 'Ivy',
          startMs: 2,
          endMs: 3,
          text: '好的，先把可以推进的事项列出来。'
        }
      ]);
  });

  it('infers speakers from repeated plain text heading lines when no speaker list exists', async () => {
    const plainText = [
      '2026-07-03 20:04:28 CST|56分钟 3秒',
      '关键词:',
      '客户、工作流、知识库',
      '',
      'Ivy',
      '先确认一下页面的整体方向。',
      '',
      'james wang',
      '可以，我先看 Landbook。',
      '',
      'Ivy',
      '然后把 Todo 列出来。',
      '',
      'james wang',
      '好的。'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .resolves.toEqual([
        {
          speakerName: 'Ivy',
          startMs: 0,
          endMs: 1,
          text: '先确认一下页面的整体方向。'
        },
        {
          speakerName: 'james wang',
          startMs: 1,
          endMs: 2,
          text: '可以，我先看 Landbook。'
        },
        {
          speakerName: 'Ivy',
          startMs: 2,
          endMs: 3,
          text: '然后把 Todo 列出来。'
        },
        {
          speakerName: 'james wang',
          startMs: 3,
          endMs: 4,
          text: '好的。'
        }
      ]);
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
