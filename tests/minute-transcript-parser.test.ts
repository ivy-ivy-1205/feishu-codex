import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MinuteTranscriptParseError,
  parseMinuteTranscriptStream
} from '../src/adapters/minute-transcript-parser.js';
import { matchFeishuHeaderlessSingleSpeakerExport } from '../src/adapters/minute-transcript-classifier.js';

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

  it('parses the verified Feishu self-speaker export only with an explicit boundary mode', async () => {
    const plainText = [
      '2026-08-07 21:52:47 CST|29秒',
      '',
      '关键词:',
      'Context、审核、来源',
      '',
      '我',
      '第一行：候选 Context 必须由 Ivy 审核。',
      '第二行：批准后才能成为正式 Context。'
    ].join('\n');

    await expect(parseMinuteTranscriptStream(Readable.from([plainText]), {
      speakerBoundaryMode: 'verified_single_speaker_without_header'
    })).resolves.toEqual([{
      speakerName: '说话人 1',
      startMs: 0,
      endMs: 1,
      text: '第一行：候选 Context 必须由 Ivy 审核。\n第二行：批准后才能成为正式 Context。'
    }]);

    await expect(parseMinuteTranscriptStream(Readable.from([plainText])))
      .rejects.toMatchObject({ code: 'MINUTE_TRANSCRIPT_INVALID' });

    const matched = matchFeishuHeaderlessSingleSpeakerExport(plainText);
    expect(matched).not.toBeNull();
    expect(plainText.slice(matched!.contentStart, matched!.contentEnd)).toBe(
      '第一行：候选 Context 必须由 Ivy 审核。\n第二行：批准后才能成为正式 Context。'
    );
  });

  it.each([
    ['a second unknown content block', [
      '2026-08-07 21:52:47 CST|29秒', '', '关键词:', 'Context、审核', '', '我',
      '第一段正文。', '', '第二个未知内容块。'
    ].join('\n')],
    ['a second suspected speaker boundary', [
      '2026-08-07 21:52:47 CST|29秒', '', '关键词:', 'Context、审核', '', '我',
      '第一段正文。', '说话人 2', '第二位发言。'
    ].join('\n')],
    ['an unnumbered suspected speaker boundary', [
      '2026-08-07 21:52:47 CST|29秒', '', '关键词:', 'Context、审核', '', '我',
      '第一段正文。', 'James', '第二位发言。'
    ].join('\n')],
    ['generic headerless prose', [
      '2026-08-07 21:52:47 CST|29秒', '关键词:', 'Context、审核', '普通无标题正文。'
    ].join('\n')],
    ['an empty body', [
      '2026-08-07 21:52:47 CST|29秒', '', '关键词:', 'Context、审核', '', '我'
    ].join('\n')]
  ])('rejects %s even when the caller requests the verified mode', async (_label, plainText) => {
    await expect(parseMinuteTranscriptStream(Readable.from([plainText]), {
      speakerBoundaryMode: 'verified_single_speaker_without_header'
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
