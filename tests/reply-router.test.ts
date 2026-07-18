import { describe, expect, it } from 'vitest';
import {
  highRiskCapabilities,
  requiresHighRiskConfirmation
} from '../src/domain/authorization.js';
import { createTestMeetingRepository } from './helpers/test-db.js';
import { routeReply, type ReplyRouterDependencies } from '../src/services/reply-router.js';

const ivyPrivateChatId = 'oc_d851c3e986007dc0f97ab582bcb2e7c8';
const ivyOpenId = 'ou_ivy';

describe('routeReply', () => {
  it('authorizes Todo 1 only for verified Ivy replying to its summary', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 1'
    })).toMatchObject({
      kind: 'authorize_low_risk',
      todoId: 'todo_a_1',
      todo: { displayedNumber: 1, risk: 'low' }
    });
  });

  it('rejects the same command from another user', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: 'ou_other',
      replyTo: 'om_summary_a',
      text: '先干 1'
    }).kind).toBe('reject');
  });

  it('does not resolve Todo 1 from a different meeting', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_b',
      text: '先干 1'
    })).toMatchObject({
      kind: 'authorize_low_risk',
      todoId: 'todo_b_1',
      todo: { summaryId: 'summary_b', displayedNumber: 1 }
    });
  });

  it('accepts an explicit Chinese ordinal without broadening to bare numbers', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先做第 1 项。'
    })).toMatchObject({ kind: 'authorize_low_risk', todoId: 'todo_a_1' });
    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '1'
    }).kind).toBe('clarify');
  });

  it('asks for clarification when reply context is missing', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: null,
      text: '先干 1'
    }).kind).toBe('clarify');
  });

  it('requires confirmation for a high-risk Todo and never authorizes it directly', () => {
    const harness = createHarness();

    const decision = harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 2'
    });

    expect(decision).toMatchObject({
      kind: 'require_high_risk_confirmation',
      todoId: 'todo_a_2',
      todo: { risk: 'high' }
    });
    expect(decision.kind).not.toBe('authorize_low_risk');
  });

  it('rejects a command outside the configured Ivy private chat', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: 'oc_project_group',
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 1'
    }).kind).toBe('reject');
  });

  it('identifies Ivy without authorizing when no approver is configured', () => {
    const harness = createHarness({ approverOpenIds: [] });

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 1'
    }).kind).toBe('identify_ivy');
  });

  it('rejects a chat ID presented as a user identity', () => {
    const harness = createHarness({ approverOpenIds: [] });

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyPrivateChatId,
      replyTo: 'om_summary_a',
      text: '先干 1'
    }).kind).toBe('reject');
  });

  it('routes an exact unique Todo title inside the replied summary', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '整理 A 的核心信息'
    })).toMatchObject({ kind: 'authorize_low_risk', todoId: 'todo_a_1' });
  });

  it('clarifies ambiguous natural language and commands containing multiple numbers', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '整理共享草稿'
    }).kind).toBe('clarify');
    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 1 和 2'
    }).kind).toBe('clarify');
  });

  it('clarifies unknown, undelivered, or non-command reply contexts', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_unknown',
      text: '先干 1'
    }).kind).toBe('clarify');
    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'pending:minute-summary:min_a',
      text: '先干 1'
    }).kind).toBe('clarify');
    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '随便做一个'
    }).kind).toBe('clarify');
  });
});

describe('requiresHighRiskConfirmation', () => {
  it('treats every external-effect capability as high risk', () => {
    for (const capability of highRiskCapabilities) {
      expect(requiresHighRiskConfirmation({ risk: 'low', capability })).toBe(true);
    }
    expect(requiresHighRiskConfirmation({ risk: 'low', capability: 'content_draft' }))
      .toBe(false);
    expect(requiresHighRiskConfirmation({ risk: 'high', capability: 'content_draft' }))
      .toBe(true);
  });
});

function createHarness(options: { approverOpenIds?: string[] } = {}) {
  const meetingRepository = createTestMeetingRepository();
  seedMeeting(meetingRepository, {
    minuteId: 'min_a',
    eventId: 'evt_a',
    summaryId: 'summary_a',
    summaryMessageId: 'om_summary_a',
    todos: [
      {
        id: 'todo_a_1',
        displayedNumber: 1,
        title: '整理 A 的核心信息',
        description: '整理会议 A',
        risk: 'low' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_2',
        displayedNumber: 2,
        title: '发给客户',
        description: '向客户发送会议结果',
        risk: 'high' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_3',
        displayedNumber: 3,
        title: '整理共享草稿',
        description: '第一份同名草稿',
        risk: 'low' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_4',
        displayedNumber: 4,
        title: '整理共享草稿',
        description: '第二份同名草稿',
        risk: 'low' as const,
        status: 'proposed' as const
      }
    ]
  });
  seedMeeting(meetingRepository, {
    minuteId: 'min_b',
    eventId: 'evt_b',
    summaryId: 'summary_b',
    summaryMessageId: 'om_summary_b',
    todos: [{
      id: 'todo_b_1',
      displayedNumber: 1,
      title: '整理 B 的核心信息',
      description: '只属于会议 B',
      risk: 'low' as const,
      status: 'proposed' as const
    }]
  });

  const dependencies: ReplyRouterDependencies = {
    meetingRepository,
    ivyPrivateChatId,
    approverOpenIds: options.approverOpenIds ?? [ivyOpenId]
  };
  return {
    route: (input: unknown) => routeReply(input, dependencies)
  };
}

function seedMeeting(
  meetingRepository: ReturnType<typeof createTestMeetingRepository>,
  input: {
    minuteId: string;
    eventId: string;
    summaryId: string;
    summaryMessageId: string;
    todos: Array<{
      id: string;
      displayedNumber: number;
      title: string;
      description: string;
      risk: 'low' | 'high';
      status: 'proposed';
    }>;
  }
): void {
  meetingRepository.ingestMinute({ minuteId: input.minuteId, eventId: input.eventId });
  meetingRepository.saveSummary({
    id: input.summaryId,
    minuteId: input.minuteId,
    summaryMessageId: input.summaryMessageId,
    content: input.summaryId,
    todos: input.todos
  });
}
