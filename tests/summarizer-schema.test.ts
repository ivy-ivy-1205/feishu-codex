import { describe, expect, it } from 'vitest';
import { MeetingSummaryDraft } from '../src/ports/summarizer.js';

const validDraft = {
  coreInsights: ['核心判断'],
  confirmedDecisions: [],
  risks: [],
  todos: []
};

const boundedDraft = {
  coreInsights: ['核心判断'],
  confirmedDecisions: ['确认决策'],
  risks: ['已知风险'],
  todos: [{
    title: '起草内容',
    description: '整理会议判断',
    risk: 'low',
    capability: 'content_draft'
  }]
};

describe('MeetingSummaryDraft bounds', () => {
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
        capability: 'content_draft'
      }]
    });

    expect(result.success).toBe(false);
  });

  it('caps every collection before persistence', () => {
    expect(MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      coreInsights: Array.from({ length: 21 }, (_, index) => `判断 ${index}`)
    }).success).toBe(false);
    expect(MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      todos: Array.from({ length: 6 }, (_, index) => ({
        title: `Todo ${index}`,
        description: '起草内容',
        risk: 'low',
        capability: 'content_draft'
      }))
    }).success).toBe(false);
  });

  it('caps the complete structured output by UTF-8 bytes', () => {
    expect(MeetingSummaryDraft.safeParse({
      ...boundedDraft,
      coreInsights: Array.from({ length: 10 }, () => '界'.repeat(2_500)),
      confirmedDecisions: Array.from({ length: 10 }, () => '界'.repeat(2_500)),
      risks: Array.from({ length: 10 }, () => '界'.repeat(2_500))
    }).success).toBe(false);
  });
});
