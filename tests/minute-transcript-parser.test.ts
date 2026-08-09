import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MinuteTranscriptParseError,
  parseMinuteTranscriptStream
} from '../src/adapters/minute-transcript-parser.js';
import { matchFeishuSingleSpeakerSrtExport } from '../src/adapters/minute-transcript-srt.js';

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

  it('keeps continuation lines inside the real speaker segment boundary', async () => {
    const plainText = [
      '2026-08-03 10:00:00 CST|多行 segment 回归',
      '',
      '发言人（2）:',
      'James、Ivy',
      '',
      'James',
      '第一行',
      '第二行',
      '',
      'Ivy',
      '后续决定'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .resolves.toEqual([
        { speakerName: 'James', startMs: 0, endMs: 1, text: '第一行\n第二行' },
        { speakerName: 'Ivy', startMs: 1, endMs: 2, text: '后续决定' }
      ]);
  });

  it('parses a real single-speaker numbered heading and preserves multiline text', async () => {
    const plainText = [
      '2026-08-07 17:30:41 CST|32秒',
      '',
      '关键词:',
      '飞书、企业',
      '',
      '说话人 1',
      '这是一场测试会议。',
      '只有经过 Ivy 审核批准后，候选才能成为正式 Context。'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .resolves.toEqual([{
        speakerName: '说话人 1',
        startMs: 0,
        endMs: 1,
        text: '这是一场测试会议。\n只有经过 Ivy 审核批准后，候选才能成为正式 Context。'
      }]);
  });

  it('keeps numbered speakers distinct and stable across whitespace and repeated segments', async () => {
    const plainText = [
      '2026-08-07 17:30:41 CST|测试会议',
      '',
      '说话人    1',
      '第一段第一行',
      '第一段第二行',
      '',
      '说话人 2',
      '第二位发言',
      '',
      '说话人\t1',
      '第一位再次发言'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .resolves.toEqual([
        {
          speakerName: '说话人 1',
          startMs: 0,
          endMs: 1,
          text: '第一段第一行\n第一段第二行'
        },
        {
          speakerName: '说话人 2',
          startMs: 1,
          endMs: 2,
          text: '第二位发言'
        },
        {
          speakerName: '说话人 1',
          startMs: 2,
          endMs: 3,
          text: '第一位再次发言'
        }
      ]);
  });

  it('does not treat an inline numbered-speaker phrase as a segment heading', async () => {
    const plainText = [
      '2026-08-07 17:30:41 CST|测试会议',
      '',
      '说话人 1',
      '正文中提到“说话人 1”时仍属于当前段落。',
      '继续保留这一行。'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .resolves.toEqual([{
        speakerName: '说话人 1',
        startMs: 0,
        endMs: 1,
        text: '正文中提到“说话人 1”时仍属于当前段落。\n继续保留这一行。'
      }]);
  });

  it('still rejects plain text without a legal speaker heading', async () => {
    const plainText = [
      '2026-08-07 17:30:41 CST|测试会议',
      '关键词:',
      '飞书、企业',
      '这段正文没有任何合法 speaker 标题。'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .rejects.toMatchObject({ code: 'MINUTE_TRANSCRIPT_INVALID' });
  });

  it('parses verified single-speaker SRT cues with exact time and multiline boundaries', async () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:04,250',
      'Ivy: 第一行：候选 Context 必须由 Ivy 审核。',
      '第二行：批准后才能成为正式 Context。',
      '',
      '2',
      '00:00:04,250 --> 00:00:09,000',
      'Ivy: 后续决定。',
      ''
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([srt]), {
      speakerBoundaryMode: 'verified_single_speaker_srt'
    })).resolves.toEqual([
      {
        speakerName: '说话人 1',
        startMs: 0,
        endMs: 4_250,
        text: '第一行：候选 Context 必须由 Ivy 审核。\n第二行：批准后才能成为正式 Context。'
      },
      {
        speakerName: '说话人 1',
        startMs: 4_250,
        endMs: 9_000,
        text: '后续决定。'
      }
    ]);

    await expect(parseMinuteTranscriptStream(Readable.from([srt])))
      .rejects.toMatchObject({ code: 'MINUTE_TRANSCRIPT_INVALID' });

    const matched = matchFeishuSingleSpeakerSrtExport(srt);
    expect(matched?.segments.map((segment) =>
      srt.slice(segment.contentStart, segment.contentEnd))).toEqual([
      '第一行：候选 Context 必须由 Ivy 审核。\n第二行：批准后才能成为正式 Context。',
      '后续决定。'
    ]);
  });

  it('accepts the byte-shaped locked Feishu SRT structure with exactly one leading empty line', async () => {
    const srt = [
      '',
      '1',
      '00:00:03,476 --> 00:00:08,226',
      'Ivy: 候选上下文必须经过审核后才能成为正式内容',
      '',
      '2',
      '00:00:08,546 --> 00:00:18,306',
      'Ivy: 批准后的上下文必须保留来源和审核动作记录系统只接受已经独立确认过的单一说话人边界不得被猜测',
      '',
      '3',
      '00:00:18,946 --> 00:00:22,346',
      'Ivy: 系统只接受已经独立确认过的单一说话人边界',
      '',
      '4',
      '00:00:22,866 --> 00:00:25,706',
      'Ivy: 后续任务只读取一次已批准的上下文',
      ''
    ].join('\n');

    expect(Buffer.byteLength(srt, 'utf8')).toBe(459);
    expect(srt.split('\n')).toHaveLength(17);
    await expect(parseMinuteTranscriptStream(Readable.from([srt]), {
      speakerBoundaryMode: 'verified_single_speaker_srt'
    })).resolves.toEqual([
      { speakerName: '说话人 1', startMs: 3_476, endMs: 8_226,
        text: '候选上下文必须经过审核后才能成为正式内容' },
      { speakerName: '说话人 1', startMs: 8_546, endMs: 18_306,
        text: '批准后的上下文必须保留来源和审核动作记录系统只接受已经独立确认过的单一说话人边界不得被猜测' },
      { speakerName: '说话人 1', startMs: 18_946, endMs: 22_346,
        text: '系统只接受已经独立确认过的单一说话人边界' },
      { speakerName: '说话人 1', startMs: 22_866, endMs: 25_706,
        text: '后续任务只读取一次已批准的上下文' }
    ]);
    expect(matchFeishuSingleSpeakerSrtExport(srt)?.segments.map((segment) =>
      srt.slice(segment.contentStart, segment.contentEnd))).toEqual([
      '候选上下文必须经过审核后才能成为正式内容',
      '批准后的上下文必须保留来源和审核动作记录系统只接受已经独立确认过的单一说话人边界不得被猜测',
      '系统只接受已经独立确认过的单一说话人边界',
      '后续任务只读取一次已批准的上下文'
    ]);
  });

  it('still rejects ordinary headerless TXT when it starts with an empty line', async () => {
    const plainText = [
      '',
      '2026-08-07 17:30:41 CST|测试会议',
      '关键词:',
      '飞书、企业',
      '这段正文没有任何合法 speaker 标题。'
    ].join('\n');

    expect(matchFeishuSingleSpeakerSrtExport(plainText)).toBeNull();
    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .rejects.toMatchObject({ code: 'MINUTE_TRANSCRIPT_INVALID' });
  });

  it.each([
    ['two distinct speaker prefixes', [
      '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', '',
      '2', '00:00:04,250 --> 00:00:09,000', 'James: 第二位发言。', ''
    ].join('\n')],
    ['a cue without a speaker prefix', [
      '1', '00:00:00,000 --> 00:00:04,250', '第一段正文。', ''
    ].join('\n')],
    ['a non-sequential cue ordinal', [
      '2', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', ''
    ].join('\n')],
    ['two leading empty lines', [
      '', '', '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', ''
    ].join('\n')],
    ['a leading space-only line', [
      ' ', '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', ''
    ].join('\n')],
    ['a leading tab-only line', [
      '\t', '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', ''
    ].join('\n')],
    ['a missing middle cue ordinal', [
      '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', '',
      '3', '00:00:04,250 --> 00:00:09,000', 'Ivy: 第三段正文。', ''
    ].join('\n')],
    ['a repeated cue ordinal', [
      '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', '',
      '1', '00:00:04,250 --> 00:00:09,000', 'Ivy: 重复编号正文。', ''
    ].join('\n')],
    ['out-of-order cue ordinals', [
      '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', '',
      '3', '00:00:04,250 --> 00:00:09,000', 'Ivy: 第三段正文。', '',
      '2', '00:00:09,000 --> 00:00:12,000', 'Ivy: 第二段正文。', ''
    ].join('\n')],
    ['an inverted cue time range', [
      '1', '00:00:04,250 --> 00:00:00,000', 'Ivy: 第一段正文。', ''
    ].join('\n')],
    ['an invalid minute component', [
      '1', '00:61:00,000 --> 00:61:04,250', 'Ivy: 第一段正文。', ''
    ].join('\n')],
    ['overlapping cue time ranges', [
      '1', '00:00:00,000 --> 00:00:05,000', 'Ivy: 第一段正文。', '',
      '2', '00:00:04,999 --> 00:00:09,000', 'Ivy: 第二段正文。', ''
    ].join('\n')],
    ['an empty cue body', [
      '1', '00:00:00,000 --> 00:00:04,250', ''
    ].join('\n')]
  ])('rejects %s in verified single-speaker SRT mode', async (_label, srt) => {
    await expect(parseMinuteTranscriptStream(Readable.from([srt]), {
      speakerBoundaryMode: 'verified_single_speaker_srt'
    })).rejects.toMatchObject({ code: 'MINUTE_TRANSCRIPT_INVALID' });
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
