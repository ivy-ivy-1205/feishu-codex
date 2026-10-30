import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { AlignmentIssueRepository } from '../src/repositories/alignment-issue-repository.js';
import { AlignmentDetector } from '../src/services/alignment-detector.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import { SpaceProjectDigestRepository } from '../src/repositories/space-project-digest-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { parseAlignmentJudgements } from '../src/services/alignment-judgement-service.js';
import { routeFounderFeedback } from '../src/services/founder-feedback-router.js';
import { buildFounderManualQueryMessages } from '../src/services/founder-manual-query.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

const at = new Date('2026-10-30T02:00:00.000Z');
const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';
const item = (text: string, blockId: string) => ({ text, blockId, excerpt: blockId === 'b1' ? '方案' : '页面' });

function setup(profile: { divergences?: ReturnType<typeof item>[]; decisions?: ReturnType<typeof item>[] } = {}) {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart-listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(at.toISOString(), at.toISOString());
  const topics = new TopicRepository(db.client), sources = new ContextSourceRepository(db.client);
  const topic = topics.createTopic({ displayName: 'Smart Listing', stage: 'active_project', outcome: null, createdAt: at });
  new FounderTopicProjectBindingRepository(db.client).recordHumanConfirmed({ topicId: topic.id, projectKey: 'smart-listing', role: 'canonical', at });
  const spaceSync = new SpaceSyncRepository(db.client);
  const binding = spaceSync.createBinding({ id: 'b1', projectKey: 'smart-listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'scheduled', createdAt: at });
  spaceSync.recordSuccessfulSync({ bindingId: binding.id, pageSequence: 1, pageUpdatedAt: '2026-10-30T01:00:00.000Z', syncedAt: at });
  const blocks = [{ id: 'b1', hash: 'a'.repeat(64), markdown: '方案' }, { id: 'b2', hash: 'b'.repeat(64), markdown: '页面' }];
  const page = sources.saveSource({ sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: 'page_1',
    logicalKey: 'chatgpt_space:page:page_1', occurredAt: '2026-10-30T01:00:00.000Z', authors: [], locatorUri: null,
    contentFormat: 'text/markdown', contentText: '方案\n\n页面', metadata: { pageId: 'page_1', blocks }, availabilityStatus: 'available', capturedAt: at }).source;
  new SpaceProjectDigestRepository(db.client).saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: page.id,
    pageSourceVersion: 1, pageUpdatedAt: page.occurredAt, generatedAt: at, changeBasis: 'first_snapshot', digest: {
      currentFocus: null, weekProgress: [], todayProgress: [], nextSteps: [], profile: { positioning: null, phases: [], completed: [],
        inProgress: [], pending: [], problems: [], divergences: profile.divergences ?? [], decisions: profile.decisions ?? [], nextPlan: [] } } });
  const alignment = new AlignmentRepository(db.client);
  alignment.configureFounderIdentity({ founder: 'ivy', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy', configuredAt: at });
  alignment.configureFounderIdentity({ founder: 'james', sourceSystem: 'feishu', externalAuthorId: 'ou_james', configuredAt: at });
  return { db, topic, sources, alignment };
}

function overview(h: ReturnType<typeof setup>, messageId = 'om_overview', now = at) {
  const message = buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'open_alignment' }, queryMessageId: `q_${messageId}`,
    chatId, approvedChatIds: [chatId], now, spaceWorkMapEnabled: true })[0]!;
  h.db.client.prepare(`INSERT INTO outbox (id, destination, payload, idempotency_key, status, created_at, delivered_at, delivered_message_id)
    VALUES (?, ?, ?, ?, 'delivered', ?, ?, ?)`).run(`out_${messageId}`, chatId, JSON.stringify(message), `key_${messageId}`,
    now.toISOString(), now.toISOString(), messageId);
  const texts = (message.card.elements as { text?: { content?: string } }[]).flatMap((element) => element.text?.content ? [element.text.content] : []);
  return { message, texts };
}

const reply = (h: ReturnType<typeof setup>, text: string, options: { messageId?: string; replyTo?: string; openId?: string } = {}) =>
  routeFounderFeedback({ chatId, openId: options.openId ?? 'ou_ivy', messageId: options.messageId ?? 'om_reply', replyTo: options.replyTo ?? 'om_overview',
    text, occurredAt: '2026-10-30T03:00:00.000Z' }, { client: h.db.client, approvedChatIds: [chatId], now: () => new Date('2026-10-30T03:00:05.000Z') });

function chatIssue(h: ReturnType<typeof setup>) {
  const evidence = (messageId: string, openId: string, text: string) => {
    const captured = captureGroupMessageSource({ chatId, messageId, threadId: null, rootId: null, author: { openId, displayName: null },
      senderType: 'user', messageType: 'text', text, occurredAt: at.toISOString() }, at);
    const source = h.sources.saveSource(captured.source).source;
    return h.sources.saveEvidence({ sourceId: source.id, excerpt: text, locator: { ...captured.messageLocator, sourceVersion: source.sourceVersion,
      contentHash: source.contentHash }, evidenceLevel: 'primary_statement', capturedAt: at }).evidence.id;
  };
  const ivy = evidence('om_i', 'ou_ivy', '首版只比较客户在意的条件'), james = evidence('om_j', 'ou_james', '首版要加入取舍分析');
  h.alignment.savePerspective({ topicId: h.topic.id, kind: 'ivy_view', expectedVersion: 0, statement: '首版只比较客户在意的条件',
    confidence: 1, evidenceIds: [ivy], decisionKey: 'scope', speechAct: 'view', observedAt: at });
  h.alignment.savePerspective({ topicId: h.topic.id, kind: 'james_view', expectedVersion: 0, statement: '首版要加入取舍分析',
    confidence: 1, evidenceIds: [james], decisionKey: 'scope', speechAct: 'view', observedAt: at });
  return new AlignmentIssueRepository(h.db.client).saveCandidate(new AlignmentDetector().propose({ topicId: h.topic.id, decisionKey: 'scope',
    dimension: 'direction', ivy: { evidenceId: ivy, statement: '首版只比较客户在意的条件' }, james: { evidenceId: james, statement: '首版要加入取舍分析' },
    actionConsequence: null, actionHorizon: null }), at);
}

describe('查看分歧 待决定 and numbered replies (Ivy 2026-10-30)', () => {
  it('shows 待决定 next to 真实分歧, numbers both, and says how to reply', () => {
    const h = setup({ divergences: [item('James 与 Ivy 对首版范围主张不同', 'b2')], decisions: [item('跨房比较首版范围有两种方案待定', 'b1')] });
    const { message, texts } = overview(h);
    expect(texts[0]!.split('\n')[1]).toBe('真实分歧 1 项 · 待决定 1 项 · 缺少另一方表达 0 项 · 已确认共识 0 项');
    expect(texts[0]).toContain('回复本卡片处理');
    expect(texts[1]).toBe('真实分歧（1）\n- 1. Smart Listing｜James 与 Ivy 对首版范围主张不同（Space 页面 10-30）');
    expect(texts[2]).toBe('待决定（1）\n- 2. Smart Listing｜跨房比较首版范围有两种方案待定（Space 页面 10-30）');
    expect(texts.map((text) => text.split('（')[0])).toEqual(expect.arrayContaining(['缺少另一方表达', '已确认共识', '最近已解决']));
    expect(message.kind === 'founder_manual_query' && message.boardView).toMatchObject({ kind: 'alignment_overview',
      counts: [{ title: '真实分歧', count: 1 }, { title: '待决定', count: 1 }, { title: '缺少另一方表达' }, { title: '已确认共识' }] });
  });

  it('parses free-form, multi-line replies and refuses anything it cannot read', () => {
    expect(parseAlignmentJudgements('第 2 条 已解决：按 A 方案')).toEqual([{ displayedNumber: 2, verdict: 'resolved', statement: '按 A 方案' }]);
    expect(parseAlignmentJudgements('2 已解决')).toEqual([{ displayedNumber: 2, verdict: 'resolved', statement: null }]);
    expect(parseAlignmentJudgements('#3 不是分歧\n第4、5条 不用决定')).toEqual([
      { displayedNumber: 3, verdict: 'not_divergence', statement: null },
      { displayedNumber: 4, verdict: 'not_divergence', statement: null }, { displayedNumber: 5, verdict: 'not_divergence', statement: null }]);
    expect(parseAlignmentJudgements('第 1 条 已决定，先做现房')).toEqual([{ displayedNumber: 1, verdict: 'resolved', statement: '先做现房' }]);
    expect(parseAlignmentJudgements('第 2 条 已解决\n这个再想想')).toBeNull();
    expect(parseAlignmentJudgements('第 2 条 已解决\n第 2 条 不是分歧')).toBeNull();
    expect(parseAlignmentJudgements('第 2 条 是不是已解决？')).toBeNull();
  });

  it('settles a Space item on one founder\'s reply, keeps the reply as evidence, and stops listing it everywhere', () => {
    const h = setup({ divergences: [item('James 与 Ivy 对首版范围主张不同', 'b2')], decisions: [item('跨房比较首版范围有两种方案待定', 'b1')] });
    overview(h);
    expect(reply(h, '第 1 条 已解决：首版只比较客户在意的条件\n第 2 条 不用决定')).toMatchObject({ kind: 'corrected',
      correctionKind: 'alignment_judgement', status: 'applied', text: expect.stringContaining('第 1 条') });
    const after = overview(h, 'om_after').texts;
    expect(after[0]!.split('\n')[1]).toBe('真实分歧 0 项 · 待决定 0 项 · 缺少另一方表达 0 项 · 已确认共识 0 项');
    expect(after.find((text) => text.startsWith('最近已解决'))).toBe(
      '最近已解决（1）\n- Smart Listing｜James 与 Ivy 对首版范围主张不同 → 首版只比较客户在意的条件（Ivy 记录 10-30）');
    const progress = (buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'q_progress', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true })[0]!.card.elements as
      { text?: { content?: string } }[]).map((element) => element.text?.content ?? '');
    expect(progress.find((text) => text.startsWith('分歧'))).toBe('分歧\n无');
    expect(progress.find((text) => text.startsWith('待决定'))).toBe('待决定\n无');
    const evidence = h.db.client.prepare(`SELECT e.excerpt FROM founder_alignment_judgements j JOIN context_evidence e ON e.id = j.evidence_id
      ORDER BY j.item_key`).all();
    expect(evidence).toHaveLength(2);
    // The same reply delivered twice is a replay, not a second judgement.
    expect(reply(h, '第 1 条 已解决：首版只比较客户在意的条件\n第 2 条 不用决定')).toMatchObject({ kind: 'duplicate' });
    expect(h.db.client.prepare('SELECT count(*) n FROM founder_alignment_judgements').get()).toEqual({ n: 2 });
    expect(h.db.client.prepare("SELECT count(*) n FROM outbox WHERE status = 'pending'").get()).toEqual({ n: 0 });
  });

  it('lists the paragraph again once the page rewrites it', () => {
    const h = setup({ divergences: [item('James 与 Ivy 对首版范围主张不同', 'b2')] });
    overview(h);
    reply(h, '1 不是分歧');
    expect(overview(h, 'om_second').texts[1]).toBe('真实分歧（0）\n无');
    const sources = new ContextSourceRepository(h.db.client);
    const rewritten = sources.saveSource({ sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: 'page_1',
      logicalKey: 'chatgpt_space:page:page_1', occurredAt: '2026-10-30T04:00:00.000Z', authors: [], locatorUri: null, contentFormat: 'text/markdown',
      contentText: '新页面', metadata: { pageId: 'page_1', blocks: [{ id: 'b3', hash: 'c'.repeat(64), markdown: '新页面' }] },
      availabilityStatus: 'available', capturedAt: at }).source;
    new SpaceProjectDigestRepository(h.db.client).saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: rewritten.id,
      pageSourceVersion: rewritten.sourceVersion, pageUpdatedAt: rewritten.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest: {
        currentFocus: null, weekProgress: [], todayProgress: [], nextSteps: [], profile: { positioning: null, phases: [], completed: [], inProgress: [],
          pending: [], problems: [], divergences: [{ text: 'James 与 Ivy 对首版范围仍有不同主张', blockId: 'b3', excerpt: '新页面' }], decisions: [], nextPlan: [] } } });
    expect(overview(h, 'om_third', new Date('2026-10-30T05:00:00.000Z')).texts[1]).toContain('1. Smart Listing｜James 与 Ivy 对首版范围仍有不同主张');
  });

  it('closes a group-chat divergence as resolved or dismissed, and asks for a fresh card when it already moved', () => {
    const h = setup();
    chatIssue(h);
    const issues = new AlignmentIssueRepository(h.db.client);
    const issue = issues.listForTopic(h.topic.id)[0]!;
    expect(issue.status).toBe('candidate');
    expect(overview(h).texts[1]).toBe('真实分歧（1）\n- 1. Smart Listing｜Ivy：首版只比较客户在意的条件 ↔ James：首版要加入取舍分析（群聊 10-30）');
    expect(reply(h, '第 1 条 已解决：先按 Ivy 的方案', { openId: 'ou_james' })).toMatchObject({ kind: 'corrected', correctionKind: 'alignment_judgement' });
    expect(issues.get(issue.id)?.status).toBe('resolved');
    expect(overview(h, 'om_after').texts.find((text) => text.startsWith('最近已解决'))).toContain('→ 先按 Ivy 的方案（James 记录 10-30）');
    // The earlier card still shows the item; a second reply to it is stale, not a second judgement.
    expect(reply(h, '第 1 条 不是分歧', { messageId: 'om_reply_2' })).toMatchObject({ kind: 'clarify', reason: 'stale_context' });
  });

  it('dismisses a group-chat divergence on 不是分歧 without recording a decision', () => {
    const h = setup();
    chatIssue(h);
    overview(h);
    reply(h, '#1 不是分歧，只是信息差');
    const issue = new AlignmentIssueRepository(h.db.client).listForTopic(h.topic.id)[0]!;
    expect(issue.status).toBe('dismissed');
    expect(overview(h, 'om_after').texts.find((text) => text.startsWith('最近已解决'))).toBe('最近已解决（0）\n无');
  });

  it('asks for the card format instead of guessing, and ignores numbers the card did not show', () => {
    const h = setup({ decisions: [item('跨房比较首版范围有两种方案待定', 'b1')] });
    overview(h);
    expect(reply(h, '这个先放一放')).toMatchObject({ kind: 'clarify', reason: 'ambiguous_feedback', text: expect.stringContaining('第 N 条 已解决') });
    expect(reply(h, '第 9 条 已解决', { messageId: 'om_reply_9' })).toMatchObject({ kind: 'clarify', reason: 'ambiguous_feedback' });
    expect(h.db.client.prepare('SELECT count(*) n FROM founder_alignment_judgements').get()).toEqual({ n: 0 });
  });
});
