import { describe, expect, it } from 'vitest';
import { createTestMeetingRepository } from './helpers/test-db.js';

describe('MeetingRepository', () => {
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
          status: 'proposed'
        },
        {
          id: 'todo_1',
          displayedNumber: 1,
          title: '发送会议纪要',
          description: '起草并发送给 Ivy',
          risk: 'low',
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
      summaryMessageId: 'om_summary_a',
      content: '会议 A',
      todos: [{
        id: 'todo_a_1',
        displayedNumber: 1,
        title: 'A 的待办',
        description: '只属于会议 A',
        risk: 'low',
        status: 'proposed'
      }]
    });
    repo.saveSummary({
      id: 'summary_b',
      minuteId: 'min_b',
      summaryMessageId: 'om_summary_b',
      content: '会议 B',
      todos: [{
        id: 'todo_b_1',
        displayedNumber: 1,
        title: 'B 的待办',
        description: '只属于会议 B',
        risk: 'low',
        status: 'proposed'
      }]
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
          status: 'proposed'
        },
        {
          id: 'todo_2',
          displayedNumber: 1,
          title: '重复编号二',
          description: '冲突',
          risk: 'high',
          status: 'proposed'
        }
      ]
    })).toThrow();

    expect(repo.listTodos('summary_1')).toEqual([]);
  });
});
