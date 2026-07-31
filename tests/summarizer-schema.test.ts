import { describe, expect, it } from 'vitest';
import { MeetingSummaryDraft } from '../src/ports/summarizer.js';

const validDraft = {
  oneLineConclusion: '核心判断',
  progress: [],
  decisions: [],
  risks: [],
  todos: []
};

const boundedDraft = {
  oneLineConclusion: '核心判断',
  progress: ['已完成进展'],
  decisions: ['确认决策'],
  risks: ['已知风险'],
  todos: [{
    title: '起草内容',
    description: '整理会议判断',
    risk: 'low',
    capability: 'content_draft',
    projectKey: null,
    subprojectKey: null,
    projectConfidence: 'low',
    projectEvidence: '会议没有足够证据',
    projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
  }]
};

describe('MeetingSummaryDraft bounds', () => {
  it('requires every Todo to include project mapping metadata and a project prompt', () => {
    expect(MeetingSummaryDraft.safeParse({
      oneLineConclusion: '核心判断',
      progress: [],
      decisions: [],
      risks: [],
      todos: [{
        title: '起草 follow-up 自动映射 Prompt',
        description: '把会议 follow-up 映射到 FeishuAdaptor。',
        risk: 'low',
        capability: 'content_draft',
        projectKey: 'feishu-adaptor',
        subprojectKey: null,
        projectConfidence: 'high',
        projectEvidence: '会议明确提到 follow-up 自动映射 Prompt。',
        projectPrompt: '在 FeishuAdaptor 中设计 follow-up 自动映射 Prompt，保持 Todo 不自动执行。'
      }]
    }).success).toBe(true);
  });

  it('rejects a mapped Todo without project evidence or prompt', () => {
    expect(MeetingSummaryDraft.safeParse({
      oneLineConclusion: '核心判断',
      progress: [],
      decisions: [],
      risks: [],
      todos: [{
        title: '整理 B-roll 优化清单',
        description: 'OpenMontage 相关。',
        risk: 'low',
        capability: 'content_draft',
        projectKey: 'openmontage',
        subprojectKey: null,
        projectConfidence: 'high',
        projectEvidence: '',
        projectPrompt: ''
      }]
    }).success).toBe(false);
  });

  it('allows an honest summary with no decisions, risks, or executable Todos', () => {
    expect(MeetingSummaryDraft.safeParse(validDraft).success).toBe(true);
  });

  it('enforces per-field UTF-8 byte limits rather than character counts', () => {
    const result = MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      todos: [{
        title: '界'.repeat(300),
        description: '起草内容',
        risk: 'low',
        capability: 'content_draft',
        projectKey: null,
        subprojectKey: null,
        projectConfidence: 'low',
        projectEvidence: '会议没有足够证据',
        projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
      }]
    });

    expect(result.success).toBe(false);
  });

  it('caps every collection before persistence', () => {
    expect(MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      progress: Array.from({ length: 21 }, (_, index) => `进展 ${index}`)
    }).success).toBe(false);
    expect(MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      todos: Array.from({ length: 6 }, (_, index) => ({
        title: `Todo ${index}`,
        description: '起草内容',
        risk: 'low',
        capability: 'content_draft',
        projectKey: null,
        subprojectKey: null,
        projectConfidence: 'low',
        projectEvidence: '会议没有足够证据',
        projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
      }))
    }).success).toBe(false);
  });

  it('caps the complete structured output by UTF-8 bytes', () => {
    expect(MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      oneLineConclusion: '界'.repeat(2_500),
      progress: Array.from({ length: 10 }, () => '界'.repeat(2_500)),
      decisions: Array.from({ length: 10 }, () => '界'.repeat(2_500)),
      risks: Array.from({ length: 10 }, () => '界'.repeat(2_500))
    }).success).toBe(false);
  });
});
