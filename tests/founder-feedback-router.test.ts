import { describe, expect, it } from 'vitest';
import { routeFounderFeedback } from '../src/services/founder-feedback-router.js';
import { feedbackHarness } from './helpers/founder-feedback-fixtures.js';

describe('founder feedback routing', () => {
  it('binds Chinese numbered merge to the delivered card numbers', () => {
    const h = feedbackHarness();
    const second = h.topicAt(2).id, fourth = h.topicAt(4).id;
    expect(routeFounderFeedback(h.input, h.dependencies)).toMatchObject({ kind: 'corrected', correctionKind: 'merge_topics' });
    expect(h.topics.listRelations()).toMatchObject([{ relationType: 'same_as' }]);
    expect(new Set(h.topics.listRelations().flatMap((r) => [r.fromTopicId, r.toTopicId]))).toEqual(new Set([second, fourth]));
    h.db.client.close();
  });
  it('keeps an unformed idea as idea when this refers to exactly one bound topic', () => {
    const h = feedbackHarness(1);
    expect(routeFounderFeedback({ ...h.input, text: '这个只是想法，还不是项目' }, h.dependencies))
      .toMatchObject({ kind: 'corrected', correctionKind: 'reclassify_stage' });
    expect(h.topics.listCurrentTopics()[0]?.stage).toBe('idea'); h.db.client.close();
  });
  it.each([
    { patch: { replyTo: null }, kind: 'clarify' },
    { patch: { replyTo: 'om_unrelated' }, kind: 'reject' },
    { patch: { chatId: 'oc_other' }, kind: 'reject' },
    { patch: { openId: 'ou_unknown' }, kind: 'reject' },
    { patch: { text: '这个只是想法，还不是项目' }, kind: 'clarify' },
    { patch: { text: '2 和 99 是同一个项目' }, kind: 'clarify' },
    { patch: { text: '可能 2 和 4 是同一个项目' }, kind: 'clarify' }
  ])('fails closed without a unique authorized meaning: $patch', ({ patch, kind }) => {
    const h = feedbackHarness();
    expect(routeFounderFeedback({ ...h.input, ...patch }, h.dependencies).kind).toBe(kind);
    expect(h.topics.listCurrentTopics().every((t) => t.currentVersion === 1)).toBe(true);
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 0 });
    h.db.client.close();
  });
  it('does not accept a pending card or a delivered row without delivered_at', () => {
    for (const delivered of [false, true]) {
      const h = feedbackHarness(4, delivered);
      if (delivered) h.db.client.prepare('UPDATE outbox SET delivered_at = NULL').run();
      expect(routeFounderFeedback(h.input, h.dependencies).kind).toBe('reject'); h.db.client.close();
    }
  });
  it('does not cross-bind a delivered map from another chat even when the topic number exists', () => {
    const h = feedbackHarness();
    h.db.client.prepare('UPDATE outbox SET destination = ?').run('oc_unrelated');
    expect(routeFounderFeedback(h.input, h.dependencies)).toMatchObject({ kind: 'reject', reason: 'unrelated_message' });
    expect(h.topics.listRelations()).toEqual([]); h.db.client.close();
  });
  it('returns no actor identity in a correction acknowledgement', () => {
    const h = feedbackHarness();
    const response = JSON.stringify(routeFounderFeedback(h.input, h.dependencies));
    expect(response).not.toContain('ou_ivy'); expect(response).not.toContain('ou_james');
    h.db.client.close();
  });
  it('does not allow a stable work-map key to silently change its numbered targets', () => {
    const h = feedbackHarness();
    const message = { ...h.map, mapId: 'map_fixture', targetChatId: h.input.chatId };
    expect(h.outbox.enqueueFounderWorkMap(message)).toEqual({ created: false });
    expect(() => h.outbox.enqueueFounderWorkMap({ ...message,
      itemRefs: message.itemRefs.map((ref) => ({ ...ref, expectedVersion: 2 })) })).toThrow('content conflict');
    expect(() => h.outbox.acknowledgeFounderWorkMapDelivery({ mapId: 'map_fixture', page: 1,
      messageId: 'om_another', deliveredAt: new Date() })).toThrow('delivery conflict');
    h.db.client.close();
  });
  it.each([
    ['第 1 项改名为 客户知识库', 'rename_topic'],
    ['暂停第 1 项', 'pause_topic'],
    ['第 1 项改为探索中', 'reclassify_stage'],
    ['第 1 项拆分为 客户知识库 和 销售助手', 'split_topic']
  ])('supports explicit correction %s', (text, correctionKind) => {
    const h = feedbackHarness(1);
    expect(routeFounderFeedback({ ...h.input, text }, h.dependencies)).toMatchObject({ kind: 'corrected', correctionKind });
    h.db.client.close();
  });
});
