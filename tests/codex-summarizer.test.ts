import { describe, expect, it } from 'vitest';
import {
  CodexMeetingSummarizer,
  meetingSummaryOutputSchema,
  type CodexJsonExecutor
} from '../src/adapters/codex-summarizer.js';
import type { ProjectContextProvider } from '../src/services/project-context.js';

const projectContextProvider: ProjectContextProvider = {
  async getProjectCards() {
    return [
      {
        projectKey: 'feishu-adaptor',
        displayName: 'FeishuAdaptor',
        aliases: ['feishu codex', '飞书 codex', 'bridge'],
        summary: '飞书 × Codex Bridge MVP。',
        localPathHint: '/Users/mengxi/Projects/FeishuAdaptor',
        repoUrl: null
      },
      {
        projectKey: 'openmontage',
        displayName: 'OpenMontage',
        aliases: ['B-roll', 'A-roll', '视频合成'],
        summary: '视频合成工作流。',
        localPathHint: '/Users/mengxi/Projects/OpenMontage',
        repoUrl: null
      }
    ];
  }
};

const minuteContext = {
  minuteId: 'min_codex_1',
  title: 'AI Native 周会',
  startedAt: '2026-07-18T02:00:00.000Z',
  endedAt: '2026-07-18T02:30:00.000Z',
  transcript: [
    {
      speakerName: 'Ivy',
      startMs: 0,
      endMs: 12_000,
      text: '我们要把飞书会议自动变成 Codex 可以推进的 Todo。'
    },
    {
      speakerName: 'Codex',
      startMs: 12_000,
      endMs: 24_000,
      text: 'Todo 必须先经过 Ivy 授权，不能自动执行。'
    }
  ]
};

describe('CodexMeetingSummarizer', () => {
  it('summarizes a minute through the Codex JSON executor and validates the structured draft', async () => {
    const calls: Parameters<CodexJsonExecutor['executeJson']>[0][] = [];
    const summarizer = new CodexMeetingSummarizer({
      projectContextProvider,
      codex: {
        async executeJson(input) {
          calls.push(input);
          return {
            oneLineConclusion: '飞书妙记是 AiJia context 管理第一入口，Todo 只生成不执行。',
            progress: ['飞书妙记是 AiJia context 管理第一入口'],
            decisions: ['Todo 生成不代表执行授权'],
            risks: ['缺少 reply context 时不能猜测 Todo'],
            todos: [{
              title: '整理会议 Todo 授权规则',
              description: '把低风险和高风险 Todo 的授权边界整理成一页说明。',
              risk: 'low',
              capability: 'content_draft',
              projectKey: 'feishu-adaptor',
              subprojectKey: null,
              projectConfidence: 'high',
              projectEvidence: '会议明确讨论飞书会议自动转 Codex Todo。',
              projectPrompt: '在 FeishuAdaptor 中整理 Todo 授权规则，不自动执行。'
            }]
          };
        }
      }
    });

    await expect(summarizer.summarize(minuteContext)).resolves.toEqual({
      oneLineConclusion: '飞书妙记是 AiJia context 管理第一入口，Todo 只生成不执行。',
      progress: ['飞书妙记是 AiJia context 管理第一入口'],
      decisions: ['Todo 生成不代表执行授权'],
      risks: ['缺少 reply context 时不能猜测 Todo'],
      todos: [{
        title: '整理会议 Todo 授权规则',
        description: '把低风险和高风险 Todo 的授权边界整理成一页说明。',
        risk: 'low',
        capability: 'content_draft',
        projectKey: 'feishu-adaptor',
        subprojectKey: null,
        projectConfidence: 'high',
        projectEvidence: '会议明确讨论飞书会议自动转 Codex Todo。',
        projectPrompt: '在 FeishuAdaptor 中整理 Todo 授权规则，不自动执行。'
      }]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outputSchema).toEqual(meetingSummaryOutputSchema);
    expect(calls[0]?.outputSchema).toMatchObject({
      properties: {
        todos: {
          items: {
            required: expect.arrayContaining([
              'projectKey',
              'projectConfidence',
              'projectEvidence',
              'projectPrompt'
            ])
          }
        }
      }
    });
    expect(calls[0]?.prompt).toContain('minute_id: min_codex_1');
    expect(calls[0]?.prompt).toContain('oneLineConclusion');
    expect(calls[0]?.prompt).not.toMatch(/30\s*[–-]\s*50\s*字/);
    expect(calls[0]?.prompt).toContain('Ivy [0-12000ms]: 我们要把飞书会议自动变成 Codex 可以推进的 Todo。');
    expect(calls[0]?.prompt).toContain('不要把需要人际判断、线下行动或外部发送的事项伪装成 Codex 可独立完成');
    expect(calls[0]?.prompt).toContain('Project Registry');
    expect(calls[0]?.prompt).toContain('FeishuAdaptor');
    expect(calls[0]?.prompt).toContain('OpenMontage');
    expect(calls[0]?.prompt).toContain('无法确定时 projectKey 必须为 null');
  });

  it('rejects Codex output that does not satisfy the meeting summary schema', async () => {
    const summarizer = new CodexMeetingSummarizer({
      projectContextProvider,
      codex: {
        async executeJson() {
          return {
            oneLineConclusion: '',
            progress: [],
            decisions: [],
            risks: [],
            todos: []
          };
        }
      }
    });

    await expect(summarizer.summarize(minuteContext)).rejects.toMatchObject({
      code: 'SUMMARIZER_OUTPUT_INVALID'
    });
  });
});
