import { describe, expect, it } from 'vitest';
import { routeFounderFeedback } from '../src/services/founder-feedback-router.js';
import { renderFounderWorkMap } from '../src/services/founder-work-map-renderer.js';
import { applyFounderBatchDraft } from '../src/services/founder-batch-correction.js';
import { feedbackHarness, feedbackNow } from './helpers/founder-feedback-fixtures.js';

describe('founder feedback routing', () => {
  it('binds Chinese numbered merge to the delivered card numbers', () => {
    const h = feedbackHarness();
    const second = h.topicAt(2).id, fourth = h.topicAt(4).id;
    expect(routeFounderFeedback(h.input, h.dependencies)).toMatchObject({ kind: 'corrected', correctionKind: 'merge_topics' });
    expect(h.topics.listRelations()).toMatchObject([{ relationType: 'same_as' }]);
    expect(new Set(h.topics.listRelations().flatMap((r) => [r.fromTopicId, r.toTopicId]))).toEqual(new Set([second, fourth]));
    h.db.client.close();
  });
  it('binds a reply on page one to numbered topics from every delivered page in the same map', () => {
    const h = feedbackHarness(13);
    const cards = renderFounderWorkMap({ since: '2026-09-01T10:00:00.000Z', until: h.input.occurredAt,
      topics: h.created.map((topic) => ({ ...topic, evidence: [] })), uncertainGrouping: [], coverageGaps: [] });
    expect(cards).toHaveLength(2);
    h.db.client.prepare('DELETE FROM outbox').run();
    for (const card of cards) {
      h.outbox.enqueueFounderWorkMap({ ...card, mapId: 'map_two_pages', targetChatId: h.input.chatId });
      h.outbox.acknowledgeFounderWorkMapDelivery({ mapId: 'map_two_pages', page: card.page,
        messageId: `om_map_${card.page}`, deliveredAt: new Date(h.input.occurredAt) });
    }
    const topic13 = cards.flatMap((card) => card.itemRefs).find((ref) => ref.displayedNumber === 13)!;
    expect(routeFounderFeedback({ ...h.input, replyTo: 'om_map_1', text: '第 13 项改为已结束' }, h.dependencies))
      .toMatchObject({ kind: 'corrected', correctionKind: 'reclassify_stage' });
    expect(h.topics.listCurrentTopics().find((topic) => topic.id === topic13.id)?.stage).toBe('closed');
    h.db.client.close();
  });
  it('drafts a multi-line correction without changing topics before explicit confirmation', () => {
    const h = feedbackHarness(14);
    const cards = renderFounderWorkMap({ since: '2026-09-01T10:00:00.000Z', until: h.input.occurredAt,
      topics: h.created.map((topic) => ({ ...topic, evidence: [] })), uncertainGrouping: [], coverageGaps: [] });
    const topic14 = cards.flatMap((card) => card.itemRefs).find((ref) => ref.displayedNumber === 14)!;
    h.db.client.prepare('DELETE FROM outbox').run();
    for (const card of cards) {
      h.outbox.enqueueFounderWorkMap({ ...card, mapId: 'map_batch_pages', targetChatId: h.input.chatId });
      h.outbox.acknowledgeFounderWorkMapDelivery({ mapId: 'map_batch_pages', page: card.page,
        messageId: `om_batch_${card.page}`, deliveredAt: new Date(h.input.occurredAt) });
    }
    const before = h.topics.listCurrentTopics().map((topic) => ({ id: topic.id, version: topic.currentVersion, stage: topic.stage }));
    const text = [
      '#4 AI 选房经验与知识库目前仍未收到 Jimmy 的回复，这个任务标注为 pending 或阻塞',
      '#5 房产销售过程数据沉淀已完成知识库入库，目前可以标注为 close',
      '#7 40 年超长期房贷已完成未发布',
      '#9、#11、#12 是同一个工作流，属于教育视频系列，已经迁移到 Space，这里删除这三个项目',
      '#10 孵化这个 AI 产业落地不能作为独立项目，只是观点讨论',
      '#13 飞书合伙人对齐：飞书 CLI 接入已完成，目前正在实现飞书白板形式的展示',
      '#14 企业微信接入暂且不再投入精力，标注为暂停',
      '不用单独再展示正在推进的项目，未归入 A/B/C 的 active topic 不形成第四个项目列表'
    ].join('\n');
    const decision = routeFounderFeedback({ ...h.input, replyTo: 'om_batch_1', text }, h.dependencies);
    expect(decision).toMatchObject({ kind: 'drafted', correctionKind: 'batch_correction', status: 'pending_confirmation' });
    expect(h.topics.listCurrentTopics().map((topic) => ({ id: topic.id, version: topic.currentVersion, stage: topic.stage }))).toEqual(before);
    const draft = h.db.client.prepare('SELECT id, status, operations_json FROM founder_feedback_drafts').get() as {
      id: string; status: string; operations_json: string;
    };
    expect(draft.status).toBe('pending');
    expect(JSON.parse(draft.operations_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'update_topic', topic: expect.objectContaining({ id: h.topicAt(5).id }), stage: 'closed' }),
      expect.objectContaining({ kind: 'merge_topics', canonicalTopic: expect.objectContaining({ id: h.topicAt(11).id }) }),
      expect.objectContaining({ kind: 'set_visibility', visibility: 'space_managed' }),
      expect.objectContaining({ kind: 'update_topic', topic: expect.objectContaining({ id: topic14.id }), stage: 'paused' }),
      expect.objectContaining({ kind: 'set_work_map_preference', hideOrphanActive: true })
    ]));
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_sources').get()).toEqual({ n: 0 });
    h.db.client.close();
  });
  it('applies an approved batch draft atomically and records the original reply as evidence', () => {
    const h = feedbackHarness(14);
    const text = [
      '#5 房产销售过程数据沉淀已完成知识库入库，目前可以标注为 close',
      '#7 40 年超长期房贷已完成未发布',
      '#8、#9、#10 是同一个工作流，属于教育视频系列，已经迁移到 Space，这里删除这三个项目',
      '#11 孵化这个 AI 产业落地不能作为独立项目，只是观点讨论',
      '#12 企业微信接入暂且不再投入精力，标注为暂停',
      '不用单独再展示正在推进的项目'
    ].join('\n');
    const draft = routeFounderFeedback({ ...h.input, text }, h.dependencies);
    expect(draft.kind).toBe('drafted');
    if (draft.kind !== 'drafted') throw new Error('expected draft');
    const applied = routeFounderFeedback({ ...h.input, messageId: 'om_confirm', replyTo: null,
      text: `确认修正 ${draft.draftId}`, occurredAt: '2026-09-21T10:01:00.000Z' }, h.dependencies);
    expect(applied).toMatchObject({ kind: 'corrected', correctionKind: 'batch_correction', status: 'applied' });
    expect(h.topicAt(5).stage).toBe('closed');
    expect(h.topicAt(7).stage).toBe('closed');
    expect(h.topicAt(11).stage).toBe('idea');
    expect(h.topicAt(12).stage).toBe('paused');
    expect(h.db.client.prepare('SELECT status FROM founder_feedback_drafts').get()).toEqual({ status: 'applied' });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_sources').get()).toEqual({ n: 1 });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 1 });
    expect(h.db.client.prepare("SELECT count(*) AS n FROM founder_topic_visibility WHERE visibility='space_managed'").get()).toEqual({ n: 3 });
    expect(h.db.client.prepare('SELECT hide_orphan_active FROM founder_work_map_preferences WHERE chat_id=?').get(h.input.chatId))
      .toEqual({ hide_orphan_active: 1 });
    expect(h.topics.listRelations().filter((relation) => relation.relationType === 'same_as')).toHaveLength(2);
    h.db.client.close();
  });
  it('rolls back every batch write when the exact obsolete feedback outbox is not pending', () => {
    const h = feedbackHarness(2);
    const draft = routeFounderFeedback({ ...h.input, text: [
      '#1 第一个项目已经完成未发布',
      '#2 第二个项目暂且不再投入精力，标注为暂停'
    ].join('\n') }, h.dependencies);
    expect(draft.kind).toBe('drafted');
    if (draft.kind !== 'drafted') throw new Error('expected draft');
    expect(() => applyFounderBatchDraft(draft.draftId, h.dependencies,
      { cancelPendingFeedbackKey: `founder-feedback:${h.input.chatId}:${h.input.messageId}` }))
      .toThrow('FOUNDER_FEEDBACK_OUTBOX_NOT_EXACT_PENDING');
    expect(h.topics.listCurrentTopics().every((topic) => topic.currentVersion === 1)).toBe(true);
    expect(h.db.client.prepare('SELECT status FROM founder_feedback_drafts').get()).toEqual({ status: 'pending' });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM founder_feedback_corrections').get()).toEqual({ n: 0 });
    expect(h.db.client.prepare('SELECT count(*) AS n FROM context_sources').get()).toEqual({ n: 0 });
    h.db.client.close();
  });
  it('includes uniquely named task and phase-goal corrections in the batch draft', () => {
    const h = feedbackHarness(2);
    const task = h.topics.createTopic({ displayName: '给静姐和 Kenny 哥 update', stage: 'active_project',
      rationale: 'Ivy confirmed Founder work map task', createdAt: new Date('2026-09-21T09:00:00.000Z') });
    const goal = h.topics.createTopic({ displayName: '飞书第一阶段目标', stage: 'active_project',
      rationale: 'Ivy confirmed Founder work map goal', createdAt: new Date('2026-09-21T09:01:00.000Z') });
    const decision = routeFounderFeedback({ ...h.input, text: [
      '#1 当前继续推进',
      '任务｜给静姐和 Kenny 哥 update（标注为已完成）',
      '↳ 阶段目标｜飞书第一阶段目标（飞书 CLI 接入已完成，目前正在实现飞书白板形式的展示）'
    ].join('\n') }, h.dependencies);
    expect(decision.kind).toBe('drafted');
    const operations = JSON.parse((h.db.client.prepare('SELECT operations_json FROM founder_feedback_drafts').get() as {operations_json:string}).operations_json);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'update_topic', topic: expect.objectContaining({ id: task.id }), stage: 'closed' }),
      expect.objectContaining({ kind: 'update_topic', topic: expect.objectContaining({ id: goal.id }),
        outcome: expect.stringContaining('飞书 CLI 接入已完成') })
    ]));
    h.db.client.close();
  });
  it('does not append another version for a numbered item already confirmed closed', () => {
    const h = feedbackHarness(3);
    expect(routeFounderFeedback({ ...h.input, text: '第 1 项改为已结束' }, h.dependencies).kind).toBe('corrected');
    const current=h.topics.listCurrentTopics();
    const [card]=renderFounderWorkMap({since:'2026-09-01T10:00:00.000Z',until:'2026-09-21T10:01:00.000Z',
      topics:current.map(topic=>({...topic,evidence:[]})),uncertainGrouping:[],coverageGaps:[]});
    h.db.client.prepare('DELETE FROM outbox').run();
    h.outbox.enqueueFounderWorkMap({...card!,mapId:'map_after_close',targetChatId:h.input.chatId});
    h.outbox.acknowledgeFounderWorkMapDelivery({mapId:'map_after_close',page:1,messageId:'om_after_close',deliveredAt:feedbackNow});
    const closedRef=card!.itemRefs.find(ref=>ref.id===h.topicAt(1).id)!;
    const closedNumber=closedRef.displayedNumber;
    const otherNumbers=card!.itemRefs.filter(ref=>ref.id!==closedRef.id).map(ref=>ref.displayedNumber);
    const decision=routeFounderFeedback({...h.input,messageId:'om_batch_after_close',replyTo:'om_after_close',text:[
      `#${closedNumber} 已结束，无需重复写版本`,
      `#${otherNumbers[0]} 已完成未发布`,
      `#${otherNumbers[1]} 暂停投入`
    ].join('\n')},h.dependencies);
    expect(decision.kind).toBe('drafted');
    const operations=JSON.parse((h.db.client.prepare('SELECT operations_json FROM founder_feedback_drafts').get() as {operations_json:string}).operations_json);
    expect(operations.some((operation:{topic?:{id:string}})=>operation.topic?.id===closedRef.id)).toBe(false);
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
  it('accepts single-item corrections that mention the bot, echo the item name or end with punctuation', () => {
    const h = feedbackHarness();
    const route = (messageId: string, text: string) => routeFounderFeedback({ ...h.input, messageId, text }, h.dependencies);
    expect(route('om_a', `@_user_1 暂停第3项${h.topicAt(3).displayName}`)).toMatchObject({ kind: 'corrected', correctionKind: 'pause_topic' });
    expect(h.topicAt(3).stage).toBe('paused');
    expect(route('om_b', '@_user_1 第4项改为已结束。')).toMatchObject({ kind: 'corrected', correctionKind: 'reclassify_stage' });
    expect(h.topicAt(4).stage).toBe('closed');
    expect(route('om_c', `第2项 ${h.topicAt(2).displayName} 已结束`)).toMatchObject({ kind: 'corrected', correctionKind: 'reclassify_stage' });
    expect(h.topicAt(2).stage).toBe('closed');
    expect(route('om_d', '#1 暂停')).toMatchObject({ kind: 'corrected', correctionKind: 'pause_topic' });
    expect(h.topicAt(1).stage).toBe('paused');
    h.db.client.close();
  });
  it('keeps a reason written after a single-item pause or close as the current direction', () => {
    const h = feedbackHarness();
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_r1', text: '@_user_1 暂停第3项，等 Jimmy 回复后再说' }, h.dependencies))
      .toMatchObject({ kind: 'corrected', correctionKind: 'pause_topic' });
    expect(h.topicAt(3)).toMatchObject({ stage: 'paused', outcome: '等 Jimmy 回复后再说' });
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_r2', text: '第4项改为已结束：已经尝试过多种方式，暂不研究' }, h.dependencies))
      .toMatchObject({ kind: 'corrected', correctionKind: 'reclassify_stage' });
    expect(h.topicAt(4)).toMatchObject({ stage: 'closed', outcome: '已经尝试过多种方式，暂不研究' });
    h.db.client.close();
  });
  it('still asks for clarification when the words name another item or ask a question', () => {
    const h = feedbackHarness();
    for (const [messageId, text] of [['om_x', '暂停第3项和第4项'], ['om_y', '第2项结束了吗'], ['om_z', '暂停第3项？']]) {
      expect(routeFounderFeedback({ ...h.input, messageId, text }, h.dependencies)).toMatchObject({ kind: 'clarify' });
    }
    expect(h.topics.listCurrentTopics().every((topic) => topic.stage === 'active_project')).toBe(true);
    h.db.client.close();
  });
  it('confirms a batch draft through a mention, trailing punctuation or a plain 确认 reply to the draft message', () => {
    const batch = '#2 暂停，等待 Jimmy 反馈\n#3 第一期已发布，系列继续制作';
    const deliverDraftReply = (h: ReturnType<typeof feedbackHarness>, draftId: string, messageId: string) => {
      h.db.client.prepare(`INSERT INTO outbox(id,destination,payload,idempotency_key,status,created_at,delivered_at,delivered_message_id)
        VALUES(?,?,?,?,'delivered',?,?,?)`).run(`fb_${messageId}`, h.input.chatId, JSON.stringify({ kind: 'founder_feedback',
        targetChatId: h.input.chatId, text: `已整理为 2 项修正草稿，尚未写入。确认无误后回复“确认修正 ${draftId}”` }),
        `fb_${messageId}`, h.input.occurredAt, h.input.occurredAt, messageId);
    };
    for (const confirm of ['mention', 'reply'] as const) {
      const h = feedbackHarness();
      const draft = routeFounderFeedback({ ...h.input, text: batch }, h.dependencies);
      if (draft.kind !== 'drafted') throw new Error('expected draft');
      deliverDraftReply(h, draft.draftId, 'om_draft_reply');
      const text = confirm === 'mention' ? `@_user_1 确认修正 ${draft.draftId}。` : '@_user_1 确认';
      const replyTo = confirm === 'mention' ? null : 'om_draft_reply';
      expect(routeFounderFeedback({ ...h.input, messageId: 'om_confirm', replyTo, text }, h.dependencies))
        .toMatchObject({ kind: 'corrected', correctionKind: 'batch_correction', status: 'applied' });
      expect(h.topicAt(2).stage).toBe('paused');
      h.db.client.close();
    }
  });
  it('does not treat a bare 确认 as consent unless it replies to a pending draft message', () => {
    const h = feedbackHarness();
    const draft = routeFounderFeedback({ ...h.input, text: '#2 暂停\n#3 第一期已发布' }, h.dependencies);
    if (draft.kind !== 'drafted') throw new Error('expected draft');
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_bare', replyTo: null, text: '确认' }, h.dependencies).kind).not.toBe('corrected');
    expect(routeFounderFeedback({ ...h.input, messageId: 'om_map_reply', replyTo: 'om_map', text: '确认' }, h.dependencies)).toMatchObject({ kind: 'clarify' });
    expect(h.db.client.prepare('SELECT status FROM founder_feedback_drafts').get()).toEqual({ status: 'pending' });
    h.db.client.close();
  });
  it('closes an item in a batch when a line explicitly changes it to 结束', () => {
    const h = feedbackHarness();
    const text = ['#2 企业微信接入 → 结束', '#3 改为已结束，已经尝试过多种方式', '#4 第一期 Killara 篇已发布，系列继续制作'].join('\n');
    const draft = routeFounderFeedback({ ...h.input, text }, h.dependencies);
    expect(draft.kind).toBe('drafted');
    const operations = JSON.parse((h.db.client.prepare('SELECT operations_json FROM founder_feedback_drafts').get() as { operations_json: string }).operations_json);
    const stageOf = (number: number) => operations.find((operation: { topic?: { id: string } }) => operation.topic?.id === h.topicAt(number).id)?.stage;
    expect(stageOf(2)).toBe('closed');
    expect(stageOf(3)).toBe('closed');
    expect(stageOf(4)).toBeUndefined();
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
