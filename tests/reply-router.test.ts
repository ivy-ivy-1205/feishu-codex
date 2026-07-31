import { describe, expect, it } from 'vitest';
import {
  highRiskCapabilities,
  requiresHighRiskConfirmation
} from '../src/domain/authorization.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { createTestMeetingRepository } from './helpers/test-db.js';
import { mapTodoToProject } from '../src/services/project-mapper.js';
import { routeReply, type ReplyRouterDependencies } from '../src/services/reply-router.js';

const ivyPrivateChatId = 'oc_d851c3e986007dc0f97ab582bcb2e7c8';
const ivyOpenId = 'ou_ivy';

describe('routeReply', () => {
  it('records a project correction for a numbered Todo reply', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '3 是 RealAgentAI_cc / Amy Voice'
    })).toMatchObject({
      kind: 'record_project_correction',
      todoId: 'todo_a_3',
      projectKey: 'realagent-ai-cc',
      subprojectKey: 'amy-voice'
    });
  });

  it('applies a numbered exact-title correction to the same Todo title in a later meeting', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '3 是 OpenMontage'
    })).toMatchObject({ kind: 'record_project_correction', projectKey: 'openmontage' });

    const projectRepository = new ProjectRepository(harness.dependencies.meetingRepository.client);
    expect(mapTodoToProject({
      title: '整理共享草稿',
      description: '这是下一次会议生成的不同描述。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请整理下一次会议的共享草稿。'
    }, {
      projects: projectRepository.listActiveProjects(),
      rules: projectRepository.listActiveRules(),
      contextSnapshots: []
    })).toMatchObject({
      projectKey: 'openmontage',
      confidence: 'high',
      status: 'mapped'
    });
  });

  it('rejects Amy subprojects paired with a non-RealAgent project', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '3 是 OpenMontage / Amy Voice'
    })).toMatchObject({ kind: 'clarify', reason: 'todo_not_found' });
    expect(harness.dependencies.meetingRepository.listTodos('summary_a')[2]).toMatchObject({
      projectKey: null,
      subprojectKey: null
    });
  });

  it('records a long-lived keyword rule when Ivy says以后', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '以后 B-roll 都归 OpenMontage'
    })).toMatchObject({
      kind: 'record_project_rule',
      pattern: 'B-roll',
      projectKey: 'openmontage'
    });
  });

  it('accepts an unambiguous long-lived rule without a summary reply', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: null,
      text: '以后 B-roll 都归 OpenMontage'
    })).toMatchObject({
      kind: 'record_project_rule',
      pattern: 'B-roll',
      projectKey: 'openmontage'
    });
  });

  it('dismisses a Todo when Ivy says it does not need Codex', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '这条不需要 Codex 推进：3'
    })).toMatchObject({
      kind: 'dismiss_todo',
      todoId: 'todo_a_3'
    });
  });

  it('corrects the only Todo matching “不是 <wrong>，是 <project>”', () => {
    const harness = createHarness();
    harness.dependencies.meetingRepository.updateTodoProjectMapping({
      todoId: 'todo_a_3',
      projectKey: 'aijia-landingpage',
      subprojectKey: null,
      projectConfidence: 'medium',
      projectEvidence: '初始映射',
      projectMappingStatus: 'mapped',
      projectPrompt: '初始 prompt'
    });

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '不是 Hero，是 OpenMontage'
    })).toMatchObject({
      kind: 'record_project_correction',
      todoId: 'todo_a_3',
      projectKey: 'openmontage'
    });
  });

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
      todo: { capability: 'external_message' }
    });
    expect(decision.kind).not.toBe('authorize_low_risk');
  });

  it('requires confirmation when capability is unknown or risk remains high', () => {
    const harness = createHarness();

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 5'
    })).toMatchObject({
      kind: 'require_high_risk_confirmation',
      todoId: 'todo_a_5',
      todo: { capability: 'unknown' }
    });
    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_summary_a',
      text: '先干 6'
    })).toMatchObject({
      kind: 'require_high_risk_confirmation',
      todoId: 'todo_a_6',
      todo: { risk: 'high', capability: 'content_draft' }
    });
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

  it('identifies Ivy before enforcing a stale private chat binding', () => {
    const harness = createHarness({ approverOpenIds: [] });

    expect(harness.route({
      chatId: 'oc_real_event_chat',
      openId: ivyOpenId,
      replyTo: null,
      text: '测试测试'
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

  it('clarifies arbitrary om_ summaries that have no delivered outbox evidence', () => {
    const harness = createHarness();
    seedUntrustedSummary(harness.dependencies.meetingRepository, {
      minuteId: 'min_direct',
      eventId: 'evt_direct',
      summaryId: 'summary_direct',
      summaryMessageId: 'om_direct_only',
      enqueueOutbox: false
    });
    seedUntrustedSummary(harness.dependencies.meetingRepository, {
      minuteId: 'min_undelivered',
      eventId: 'evt_undelivered',
      summaryId: 'summary_undelivered',
      summaryMessageId: 'om_undelivered',
      enqueueOutbox: true
    });

    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_direct_only',
      text: '先干 1'
    }).kind).toBe('clarify');
    expect(harness.route({
      chatId: ivyPrivateChatId,
      openId: ivyOpenId,
      replyTo: 'om_undelivered',
      text: '先干 1'
    }).kind).toBe('clarify');
  });

  it('clarifies unknown, pending, or non-command reply contexts', () => {
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
  it('allows only the explicit safe capability and fails closed otherwise', () => {
    for (const capability of highRiskCapabilities) {
      expect(requiresHighRiskConfirmation({ risk: 'low', capability })).toBe(true);
    }
    expect(requiresHighRiskConfirmation({ risk: 'low' })).toBe(true);
    expect(requiresHighRiskConfirmation({ risk: 'low', capability: 'invented_capability' }))
      .toBe(true);
    expect(requiresHighRiskConfirmation({ risk: 'low', capability: 'unknown' })).toBe(true);
    expect(requiresHighRiskConfirmation({ risk: 'low', capability: 'content_draft' })).toBe(false);
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
        capability: 'content_draft' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_2',
        displayedNumber: 2,
        title: '发给客户',
        description: '向客户发送会议结果',
        risk: 'low' as const,
        capability: 'external_message' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_3',
        displayedNumber: 3,
        title: '整理共享草稿',
        description: '第一份同名草稿',
        risk: 'low' as const,
        capability: 'content_draft' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_4',
        displayedNumber: 4,
        title: '整理共享草稿',
        description: '第二份同名草稿',
        risk: 'low' as const,
        capability: 'content_draft' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_5',
        displayedNumber: 5,
        title: '未分类任务',
        description: '能力分类缺失时不得直接授权',
        risk: 'low' as const,
        capability: 'unknown' as const,
        status: 'proposed' as const
      },
      {
        id: 'todo_a_6',
        displayedNumber: 6,
        title: '高风险内容任务',
        description: '即使能力安全，风险仍需确认',
        risk: 'high' as const,
        capability: 'content_draft' as const,
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
      capability: 'content_draft' as const,
      status: 'proposed' as const
    }]
  });

  const dependencies: ReplyRouterDependencies = {
    meetingRepository,
    ivyPrivateChatId,
    approverOpenIds: options.approverOpenIds ?? [ivyOpenId]
  };
  return {
    dependencies,
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
      capability: 'unknown' | 'content_draft' | 'code_write' | 'external_message' |
        'deploy' | 'delete' | 'production_access';
      projectKey?: string | null;
      subprojectKey?: string | null;
      projectConfidence?: 'high' | 'medium' | 'low';
      projectEvidence?: string;
      projectPrompt?: string;
      status: 'proposed';
    }>;
  }
): void {
  meetingRepository.ingestMinute({ minuteId: input.minuteId, eventId: input.eventId });
  meetingRepository.saveSummary({
    id: input.summaryId,
    minuteId: input.minuteId,
    summaryMessageId: `pending:minute-summary:${input.minuteId}`,
    content: input.summaryId,
    todos: input.todos
  });
  const outboxRepository = new OutboxRepository(meetingRepository.client);
  outboxRepository.enqueueMeetingSummary({
    kind: 'ivy_meeting_summary',
    minuteId: input.minuteId,
    summaryId: input.summaryId,
    targetChatId: ivyPrivateChatId,
    meeting: {
      title: input.summaryId,
      startedAt: '2030-07-18T00:00:00.000Z',
      endedAt: '2030-07-18T00:30:00.000Z'
    },
    body: input.summaryId,
    oneLineConclusion: '测试回复绑定。',
    progress: ['测试回复绑定'],
    decisions: ['只授权已投递总结'],
    risks: ['伪造 replyTo'],
    todos: input.todos.map(({
      title,
      description,
      risk,
      capability,
      projectKey = null,
      subprojectKey = null,
      projectConfidence = 'low',
      projectEvidence = '会议没有足够证据',
      projectPrompt = '需要 Ivy 先确认项目的下一步问题。'
    }) => ({
      title,
      description,
      risk,
      capability,
      projectKey,
      subprojectKey,
      projectConfidence,
      projectEvidence,
      projectPrompt
    }))
  });
  outboxRepository.acknowledgeMeetingSummaryDelivery({
    minuteId: input.minuteId,
    messageId: input.summaryMessageId,
    deliveredAt: new Date('2030-07-18T04:00:00.000Z')
  });
}

function seedUntrustedSummary(
  meetingRepository: ReturnType<typeof createTestMeetingRepository>,
  input: {
    minuteId: string;
    eventId: string;
    summaryId: string;
    summaryMessageId: string;
    enqueueOutbox: boolean;
  }
): void {
  meetingRepository.ingestMinute({ minuteId: input.minuteId, eventId: input.eventId });
  const todo = {
    id: `todo:${input.minuteId}:1`,
    displayedNumber: 1,
    title: '不可信任务',
    description: '不能只相信 om_ 格式',
    risk: 'low' as const,
    capability: 'content_draft' as const,
    status: 'proposed' as const
  };
  meetingRepository.saveSummary({
    id: input.summaryId,
    minuteId: input.minuteId,
    summaryMessageId: input.summaryMessageId,
    content: input.summaryId,
    todos: [todo]
  });
  if (input.enqueueOutbox) {
    new OutboxRepository(meetingRepository.client).enqueueMeetingSummary({
      kind: 'ivy_meeting_summary',
      minuteId: input.minuteId,
      summaryId: input.summaryId,
      targetChatId: ivyPrivateChatId,
      meeting: {
        title: input.summaryId,
        startedAt: '2030-07-18T00:00:00.000Z',
        endedAt: '2030-07-18T00:30:00.000Z'
      },
      body: input.summaryId,
      oneLineConclusion: '尚未投递。',
      progress: ['尚未投递'],
      decisions: ['不能授权'],
      risks: ['伪造消息 ID'],
      todos: [{
        title: todo.title,
        description: todo.description,
        risk: todo.risk,
        capability: todo.capability,
        projectKey: null,
        subprojectKey: null,
        projectConfidence: 'low',
        projectEvidence: '会议没有足够证据',
        projectPrompt: '需要 Ivy 先确认项目的下一步问题。'
      }]
    });
  }
}
