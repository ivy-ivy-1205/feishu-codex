import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { meetingTodos } from '../src/db/schema.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { createTestMeetingRepository } from './helpers/test-db.js';

describe('MeetingRepository', () => {
  it('declares every Todo CHECK constraint used by the SQLite migration', () => {
    expect(getTableConfig(meetingTodos).checks.map((constraint) => constraint.name)).toEqual([
      'meeting_todos_displayed_number_positive',
      'meeting_todos_risk_allowed',
      'meeting_todos_capability_allowed',
      'meeting_todos_status_allowed'
    ]);
  });

  it('stores a minute only once', () => {
    const repo = createTestMeetingRepository();

    expect(repo.ingestMinute({ minuteId: 'min_1', eventId: 'evt_1' }).created).toBe(true);
    expect(repo.ingestMinute({ minuteId: 'min_1', eventId: 'evt_2' }).created).toBe(false);
  });

  it('stores a summary and lists its todos in displayed order', () => {
    const repo = createTestMeetingRepository();
    repo.ingestMinute({ minuteId: 'min_1', eventId: 'evt_1' });

    const summary = repo.saveSummary({
      id: 'summary_1',
      minuteId: 'min_1',
      summaryMessageId: 'om_summary_1',
      content: '讨论了下一步。',
      todos: [
        {
          id: 'todo_2',
          displayedNumber: 2,
          title: '跟进预算',
          description: '整理预算草案',
          risk: 'high',
          capability: 'external_message',
          status: 'proposed'
        },
        {
          id: 'todo_1',
          displayedNumber: 1,
          title: '发送会议纪要',
          description: '起草并发送给 Ivy',
          risk: 'low',
          capability: 'content_draft',
          status: 'proposed'
        }
      ]
    });

    expect(summary.id).toBe('summary_1');
    expect(repo.listTodos(summary.id).map((todo) => todo.id)).toEqual(['todo_1', 'todo_2']);
  });

  it('resolves a displayed number only inside its summary message', () => {
    const repo = createTestMeetingRepository();
    repo.ingestMinute({ minuteId: 'min_a', eventId: 'evt_a' });
    repo.ingestMinute({ minuteId: 'min_b', eventId: 'evt_b' });
    repo.saveSummary({
      id: 'summary_a',
      minuteId: 'min_a',
      summaryMessageId: 'pending:minute-summary:min_a',
      content: '会议 A',
      todos: [{
        id: 'todo_a_1',
        displayedNumber: 1,
        title: 'A 的待办',
        description: '只属于会议 A',
        risk: 'low',
        capability: 'content_draft',
        status: 'proposed'
      }]
    });
    repo.saveSummary({
      id: 'summary_b',
      minuteId: 'min_b',
      summaryMessageId: 'pending:minute-summary:min_b',
      content: '会议 B',
      todos: [{
        id: 'todo_b_1',
        displayedNumber: 1,
        title: 'B 的待办',
        description: '只属于会议 B',
        risk: 'low',
        capability: 'content_draft',
        status: 'proposed'
      }]
    });

    deliverSummary(repo, {
      minuteId: 'min_a',
      summaryId: 'summary_a',
      messageId: 'om_summary_a',
      title: 'A 的待办'
    });
    deliverSummary(repo, {
      minuteId: 'min_b',
      summaryId: 'summary_b',
      messageId: 'om_summary_b',
      title: 'B 的待办'
    });

    expect(repo.findTodoByReply('om_summary_a', 1)?.id).toBe('todo_a_1');
    expect(repo.findTodoByReply('om_summary_b', 1)?.id).toBe('todo_b_1');
    expect(repo.findTodoByReply('om_unknown', 1)).toBeNull();
  });

  it('rolls back a summary when its todo numbers conflict', () => {
    const repo = createTestMeetingRepository();
    repo.ingestMinute({ minuteId: 'min_1', eventId: 'evt_1' });

    expect(() => repo.saveSummary({
      id: 'summary_1',
      minuteId: 'min_1',
      summaryMessageId: 'om_summary_1',
      content: '不会被保存',
      todos: [
        {
          id: 'todo_1',
          displayedNumber: 1,
          title: '重复编号一',
          description: '冲突',
          risk: 'low',
          capability: 'content_draft',
          status: 'proposed'
        },
        {
          id: 'todo_2',
          displayedNumber: 1,
          title: '重复编号二',
          description: '冲突',
          risk: 'high',
          capability: 'external_message',
          status: 'proposed'
        }
      ]
    })).toThrow();

    expect(repo.listTodos('summary_1')).toEqual([]);
  });
});

function deliverSummary(
  repo: ReturnType<typeof createTestMeetingRepository>,
  input: { minuteId: string; summaryId: string; messageId: string; title: string }
): void {
  const outbox = new OutboxRepository(repo.client);
  outbox.enqueueMeetingSummary({
    kind: 'ivy_meeting_summary',
    minuteId: input.minuteId,
    summaryId: input.summaryId,
    targetChatId: 'oc_fixture_ivy',
    coreInsights: ['测试作用域'],
    confirmedDecisions: ['只接受已投递消息'],
    risks: ['跨会议编号'],
    todos: [{
      title: input.title,
      description: input.title,
      risk: 'low',
      capability: 'content_draft'
    }]
  });
  outbox.acknowledgeMeetingSummaryDelivery({
    minuteId: input.minuteId,
    messageId: input.messageId,
    deliveredAt: new Date('2030-07-18T04:00:00.000Z')
  });
}
