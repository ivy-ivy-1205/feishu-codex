import { describe, expect, it } from 'vitest';
import { CodexMeetingSummarizer } from '../src/adapters/codex-summarizer.js';
import { CodexAuthProbe, CodexCliAdapter, NodeCodexProcessRunner } from '../src/adapters/codex-cli.js';
import { createMeetingSummarizer } from '../src/composition/meeting-summarizer.js';

const baseConfig = {
  codex: {
    command: 'codex',
    workdir: '/tmp/aijia-codex-readonly',
    timeoutSeconds: 120,
    summarizerMode: 'fake'
  }
} as const;

describe('createMeetingSummarizer', () => {
  it('keeps production composition on fake summarizer by default', async () => {
    const summarizer = createMeetingSummarizer({
      config: baseConfig,
      env: { PATH: '/usr/bin' }
    });

    await expect(summarizer.summarize({
      minuteId: 'min_comp_1',
      title: 'AI Native 周会',
      startedAt: '2026-07-18T02:00:00.000Z',
      endedAt: '2026-07-18T02:30:00.000Z',
      transcript: [{
        speakerName: 'Ivy',
        startMs: 0,
        endMs: 1_000,
        text: '默认不能调用真实 Codex。'
      }]
    })).resolves.toMatchObject({
      oneLineConclusion: '当前 summarizer 仍使用 fake 模式，尚未启用真实 Codex。',
      progress: ['当前 summarizer 仍使用 fake 模式，尚未启用真实 Codex。'],
      todos: []
    });
  });

  it('wires CodexMeetingSummarizer only when CODEX_SUMMARIZER_MODE is codex', () => {
    const summarizer = createMeetingSummarizer({
      config: {
        ...baseConfig,
        codex: {
          ...baseConfig.codex,
          summarizerMode: 'codex'
        }
      },
      env: { PATH: '/usr/bin' }
    });

    expect(summarizer).toBeInstanceOf(CodexMeetingSummarizer);
  });

  it('builds the Codex CLI execution stack with configured command, workdir, timeout, and env', () => {
    const stack = createMeetingSummarizer({
      config: {
        ...baseConfig,
        codex: {
          command: '/usr/local/bin/codex',
          workdir: '/opt/feishu-codex/codex-workdir',
          timeoutSeconds: 90,
          summarizerMode: 'codex'
        }
      },
      env: { PATH: '/usr/bin' },
      exposeInternalsForTest: true
    });

    expect(stack.summarizer).toBeInstanceOf(CodexMeetingSummarizer);
    expect(stack.codex).toBeInstanceOf(CodexCliAdapter);
    expect(stack.authProbe).toBeInstanceOf(CodexAuthProbe);
    expect(stack.runner).toBeInstanceOf(NodeCodexProcessRunner);
    expect(stack.codexOptions).toEqual({
      command: '/usr/local/bin/codex',
      workdir: '/opt/feishu-codex/codex-workdir',
      timeoutMs: 90_000,
      baseEnv: { PATH: '/usr/bin' }
    });
  });
});
