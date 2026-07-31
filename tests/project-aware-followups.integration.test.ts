import { describe, expect, it } from 'vitest';
import { runMeetingLoopFixture } from './helpers/meeting-loop-fixture.js';

describe('project-aware followups integration', () => {
  it('maps known projects, leaves unknown items pending, and stores project prompts', async () => {
    const result = await runMeetingLoopFixture({
      transcript: [
        'Ivy: OpenMontage 的 B-roll 素材还是单薄，今天要整理优化清单。',
        'Ivy: follow-up 自动映射 Prompt 属于 FeishuAdaptor。',
        'Ivy: Amy Live 复测和 Demo 剪辑也要整理一下。',
        'Ivy: compass 下一步也要有一个 prompt。',
        'Ivy: 还有一个没命名的新实验先别猜项目。'
      ]
    });

    expect(result.renderedText).toContain('[OpenMontage｜高置信度] 整理视频号 B-roll 优化清单');
    expect(result.renderedText).toContain('[FeishuAdaptor｜高置信度] 起草 follow-up 自动映射 Prompt');
    expect(result.renderedText).toContain('[RealAgentAI_cc｜高置信度] 生成 Amy Live 复测与 Demo 剪辑清单');
    expect(result.renderedText).toContain('[aijia-compass-work｜高置信度]');
    expect(result.renderedText).toContain('[待确认项目]');
    expect(result.todos.every((todo) => todo.status === 'proposed')).toBe(true);
    expect(result.todos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '整理视频号 B-roll 优化清单',
        projectKey: 'openmontage',
        projectMappingStatus: 'mapped',
        projectEvidence: 'system:system:b-roll matched B-roll',
        projectPrompt: '在 OpenMontage 中整理视频号 B-roll 优化清单。'
      }),
      expect.objectContaining({
        title: '起草 follow-up 自动映射 Prompt',
        projectKey: 'feishu-adaptor',
        projectMappingStatus: 'mapped',
        projectEvidence: 'system:system:follow-up-mapping matched follow-up 自动映射',
        projectPrompt: '在 FeishuAdaptor 中起草 follow-up 自动映射 Prompt。'
      }),
      expect.objectContaining({
        title: '生成 Amy Live 复测与 Demo 剪辑清单',
        projectKey: 'realagent-ai-cc',
        projectMappingStatus: 'mapped',
        projectEvidence: 'system:system:amy-live matched Amy Live',
        projectPrompt: '在 RealAgentAI_cc 的 Amy Voice 分支生成复测与 Demo 剪辑清单。'
      }),
      expect.objectContaining({
        title: '整理 compass 下一步 Prompt',
        projectKey: 'aijia-compass-work',
        projectMappingStatus: 'mapped',
        projectEvidence: 'system:system:compass matched compass',
        projectPrompt: '在 aijia-compass-work 中整理下一步 Prompt。'
      }),
      expect.objectContaining({
        title: '澄清新实验所属项目',
        projectKey: null,
        projectMappingStatus: 'needs_confirmation',
        projectPrompt: '请 Ivy 先确认新实验所属项目，再生成下一步 Prompt。'
      })
    ]));
  });
});
