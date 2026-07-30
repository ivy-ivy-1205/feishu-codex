import { CodexAuthProbe, CodexCliAdapter, NodeCodexProcessRunner } from '../adapters/codex-cli.js';
import { CodexMeetingSummarizer } from '../adapters/codex-summarizer.js';
import type { MeetingSummarizer, MeetingSummaryDraft } from '../ports/summarizer.js';
import type { MinuteContext } from '../ports/feishu.js';

export interface MeetingSummarizerCompositionConfig {
  codex: {
    command: string;
    workdir: string;
    timeoutSeconds: number;
    summarizerMode: 'fake' | 'codex';
  };
}

export interface CreateMeetingSummarizerOptions {
  config: MeetingSummarizerCompositionConfig;
  env?: Record<string, string | undefined>;
  exposeInternalsForTest?: false;
}

export interface CreateMeetingSummarizerTestOptions {
  config: MeetingSummarizerCompositionConfig;
  env?: Record<string, string | undefined>;
  exposeInternalsForTest: true;
}

export interface MeetingSummarizerStackForTest {
  summarizer: MeetingSummarizer;
  codex: CodexCliAdapter;
  authProbe: CodexAuthProbe;
  runner: NodeCodexProcessRunner;
  codexOptions: {
    command: string;
    workdir: string;
    timeoutMs: number;
    baseEnv: Record<string, string | undefined>;
  };
}

export function createMeetingSummarizer(
  options: CreateMeetingSummarizerTestOptions
): MeetingSummarizerStackForTest;
export function createMeetingSummarizer(
  options: CreateMeetingSummarizerOptions
): MeetingSummarizer;
export function createMeetingSummarizer(
  options: CreateMeetingSummarizerOptions | CreateMeetingSummarizerTestOptions
): MeetingSummarizer | MeetingSummarizerStackForTest {
  if (options.config.codex.summarizerMode === 'fake') {
    return new FakeMeetingSummarizer();
  }

  const runner = new NodeCodexProcessRunner();
  const codexOptions = {
    command: options.config.codex.command,
    workdir: options.config.codex.workdir,
    timeoutMs: options.config.codex.timeoutSeconds * 1_000,
    baseEnv: options.env ?? process.env
  };
  const codex = new CodexCliAdapter({
    ...codexOptions,
    runner
  });
  const authProbe = new CodexAuthProbe({
    ...codexOptions,
    runner
  });
  const summarizer = new CodexMeetingSummarizer({ codex });

  if (options.exposeInternalsForTest) {
    return {
      summarizer,
      codex,
      authProbe,
      runner,
      codexOptions
    };
  }

  return summarizer;
}

class FakeMeetingSummarizer implements MeetingSummarizer {
  async summarize(_context: MinuteContext): Promise<MeetingSummaryDraft> {
    return {
      oneLineConclusion: '当前 summarizer 仍使用 fake 模式，尚未启用真实 Codex。',
      progress: ['当前 summarizer 仍使用 fake 模式，尚未启用真实 Codex。'],
      decisions: [],
      risks: [],
      todos: []
    };
  }
}
