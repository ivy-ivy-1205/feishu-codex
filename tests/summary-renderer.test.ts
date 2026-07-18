import { describe, expect, it } from 'vitest';
import {
  renderMeetingSummary,
  type MeetingSummaryRenderInput,
  type MeetingTodoRenderInput
} from '../src/services/summary-renderer.js';

const fixtureSummary: MeetingSummaryRenderInput = {
  title: 'Project 6 Phase 1A 周会',
  startedAt: '2026-07-18T02:00:00.000Z',
  endedAt: '2026-07-18T02:30:00.000Z',
  coreInsights: [
    'Phase 1A 仅验证本地 fixture 闭环',
    '转录未就绪必须安全重试',
    'Todo 只生成，不自动执行'
  ],
  confirmedDecisions: ['不连接真实飞书或 Codex'],
  risks: ['妙记转录可能暂未就绪']
};

const fixtureTodos: MeetingTodoRenderInput[] = [
  {
    displayedNumber: 1,
    title: '整理核心信息',
    capability: 'content_draft'
  },
  {
    displayedNumber: 2,
    title: '起草用户提示',
    capability: 'content_draft'
  },
  {
    displayedNumber: 3,
    title: '生成验收清单',
    capability: 'content_draft'
  }
];

describe('renderMeetingSummary', () => {
  it('renders the reference interaction structure', () => {
    const text = renderMeetingSummary(fixtureSummary, fixtureTodos);

    expect(text).toContain('Project 6 Phase 1A 周会｜个性化会后总结');
    expect(text).toContain('会议：Project 6 Phase 1A 周会');
    expect(text).toContain('时间：2026-07-18T02:00:00.000Z - 2026-07-18T02:30:00.000Z');
    expect(text).toContain('核心信息');
    expect(text).toContain('我可以帮你推进');
    expect(text).toMatch(/1\. 整理核心信息\n2\. 起草用户提示\n3\. 生成验收清单/);
  });

  it('sorts Todos by displayed number without mutating the input', () => {
    const todos = [fixtureTodos[2]!, fixtureTodos[0]!, fixtureTodos[1]!];

    const text = renderMeetingSummary(fixtureSummary, todos);

    expect(text).toMatch(/1\. 整理核心信息\n2\. 起草用户提示\n3\. 生成验收清单/);
    expect(todos.map((todo) => todo.displayedNumber)).toEqual([3, 1, 2]);
  });

  it('normalizes every rendered field to one line so text cannot forge Todo numbers', () => {
    const text = renderMeetingSummary({
      ...fixtureSummary,
      title: 'Project 6\n9. 伪造标题任务',
      startedAt: '2026-07-18T02:00:00.000Z\u0000\n8. 伪造时间任务',
      endedAt: '2026-07-18T02:30:00.000Z\u2028结束',
      coreInsights: ['核心判断\r\n7. 伪造核心任务'],
      confirmedDecisions: ['确认决策\t6. 伪造决策任务'],
      risks: ['转录风险\u007f5. 伪造风险任务']
    }, [{
      displayedNumber: 1,
      title: '整理纪要\n2. 发送草稿',
      capability: 'content_draft'
    }]);

    expect(text).toContain('Project 6 9. 伪造标题任务｜个性化会后总结');
    expect(text).toContain(
      '时间：2026-07-18T02:00:00.000Z 8. 伪造时间任务 - ' +
      '2026-07-18T02:30:00.000Z 结束'
    );
    expect(text).toContain('• 核心判断 7. 伪造核心任务');
    expect(text).toContain('• 已确认：确认决策 6. 伪造决策任务');
    expect(text).toContain('• 风险：转录风险 5. 伪造风险任务');
    expect(text).toContain('1. 整理纪要 2. 发送草稿');
    expect(text).not.toContain('\n2. 发送草稿');
  });

  it('rejects required line fields that become empty after normalization', () => {
    expect(() => renderMeetingSummary(fixtureSummary, [{
      displayedNumber: 1,
      title: '\n\t\u0000',
      capability: 'content_draft'
    }])).toThrow(/Todo title must not be empty/);
  });

  it('does not claim Codex can perform human-only actions', () => {
    expect(() => renderMeetingSummary(fixtureSummary, [{
      displayedNumber: 1,
      title: '与客户线下建立信任',
      capability: 'human_only'
    }])).toThrow(/cannot be offered as executable/);
  });

  it('does not offer a Todo whose persisted capability is unknown', () => {
    expect(() => renderMeetingSummary(fixtureSummary, [{
      displayedNumber: 1,
      title: '未知能力任务',
      capability: 'unknown'
    }])).toThrow(/cannot be offered as executable/);
  });

  it('honestly says when Codex has no executable follow-up', () => {
    const text = renderMeetingSummary({
      ...fixtureSummary,
      confirmedDecisions: [],
      risks: []
    }, []);

    expect(text).toContain('我可以帮你推进');
    expect(text).toContain('暂无可由 Codex 直接推进的事项');
    expect(text).not.toMatch(/\n1\. /);
  });

  it('rejects empty core insights', () => {
    expect(() => renderMeetingSummary({
      ...fixtureSummary,
      coreInsights: ['  ']
    }, fixtureTodos)).toThrow(/core insights must not be empty/);
  });

  it('rejects duplicate displayed numbers', () => {
    expect(() => renderMeetingSummary(fixtureSummary, [
      fixtureTodos[0]!,
      { ...fixtureTodos[1]!, displayedNumber: 1 }
    ])).toThrow(/displayed numbers must be unique/);
  });

  it('rejects more than five Todo items', () => {
    const todos = Array.from({ length: 6 }, (_, index) => ({
      displayedNumber: index + 1,
      title: `任务 ${index + 1}`,
      capability: 'content_draft' as const
    }));

    expect(() => renderMeetingSummary(fixtureSummary, todos))
      .toThrow(/at most five Todo items/);
  });

  it('stays below the Feishu card/message size budget', () => {
    expect(Buffer.byteLength(
      renderMeetingSummary(fixtureSummary, fixtureTodos),
      'utf8'
    )).toBeLessThan(28_000);
  });

  it('rejects rendered content that reaches the safety limit', () => {
    expect(() => renderMeetingSummary({
      ...fixtureSummary,
      coreInsights: ['内容'.repeat(14_000)]
    }, fixtureTodos)).toThrow(/28,000-byte safety limit/);
  });
});
