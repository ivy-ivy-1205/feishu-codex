import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import { SpaceProjectDigestRepository } from '../src/repositories/space-project-digest-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { buildFounderManualQueryMessages } from '../src/services/founder-manual-query.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import { loadSpaceProjectPageView, renderSpaceProjectPageLines, spaceBoardSummary } from '../src/services/space-project-page-view.js';
import { buildSpaceMarkdownEnvelope } from '../src/services/space-markdown-envelope.js';
import { ingestSpaceSyncEnvelope } from '../src/services/space-sync-ingestion.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

const at = new Date('2026-10-21T02:00:00.000Z');
const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart-listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(at.toISOString(), at.toISOString());
  const topics = new TopicRepository(db.client), sources = new ContextSourceRepository(db.client);
  const topic = topics.createTopic({ displayName: 'Smart Listing', stage: 'active_project', outcome: '27 Cecil Street 上线', createdAt: at });
  new FounderTopicProjectBindingRepository(db.client).recordHumanConfirmed({ topicId: topic.id, projectKey: 'smart-listing', role: 'canonical', at });
  const spaceSync = new SpaceSyncRepository(db.client);
  const binding = spaceSync.createBinding({ id: 'b1', projectKey: 'smart-listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: at });
  spaceSync.recordSuccessfulSync({ bindingId: binding.id, pageSequence: 1, pageUpdatedAt: '2026-10-21T01:00:00.000Z', syncedAt: at });
  const page = sources.saveSource({ sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: 'page_1',
    logicalKey: 'chatgpt_space:page:page_1', occurredAt: '2026-10-21T01:00:00.000Z', authors: [], locatorUri: null,
    contentFormat: 'text/markdown', contentText: '页面', metadata: { pageId: 'page_1', blocks: [{ id: 'b1', hash: 'a'.repeat(64), markdown: '页面' }] },
    availabilityStatus: 'available', capturedAt: at }).source;
  const comment = (messageId: string, authorId: string, threadState: 'open' | 'resolved') => sources.saveSource({
    sourceSystem: 'chatgpt_space', sourceType: 'space_page_comment', externalId: messageId,
    logicalKey: `chatgpt_space:page:page_1:thread:t:message:${messageId}`, occurredAt: at.toISOString(),
    authors: [{ openId: authorId, displayName: null }], locatorUri: null, contentFormat: 'text/plain', contentText: '评论',
    metadata: { pageId: 'page_1', threadId: 't', messageId, authorOpenId: authorId, threadState, targetBlockId: null },
    availabilityStatus: 'available', capturedAt: at });
  return { db, topic, page, comment, digests: new SpaceProjectDigestRepository(db.client) };
}

const digest = {
  currentFocus: { text: '把 27 Cecil Street 买家空间做成可复用模板', blockId: 'b1', excerpt: '页面' },
  weekProgress: [{ text: '27 Cecil Street 页面上线', blockId: 'b1', excerpt: '页面' }, { text: '补齐户型图', blockId: 'b1', excerpt: '页面' }],
  todayProgress: [{ text: '补齐周边配套', blockId: 'b1', excerpt: '页面' }],
  nextSteps: [{ kind: 'blocker' as const, text: '第二套 listing 等 Amy 确认', blockId: 'b1', excerpt: '页面' }],
  profile: { positioning: null, phases: [], completed: [], inProgress: [], pending: [], problems: [], divergences: [], nextPlan: [] }
};

describe('Space project-page block', () => {
  it('renders this week, today, focus, next/blockers and a one-line comment summary', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    const alignment = new AlignmentRepository(h.db.client);
    alignment.configureFounderIdentity({ founder: 'ivy', sourceSystem: 'chatgpt_space', externalAuthorId: 'u_ivy', configuredAt: at });
    alignment.configureFounderIdentity({ founder: 'james', sourceSystem: 'chatgpt_space', externalAuthorId: 'u_james', configuredAt: at });
    h.comment('m1', 'u_ivy', 'open'); h.comment('m2', 'u_james', 'open'); h.comment('m3', 'agent', 'open'); h.comment('m4', 'u_ivy', 'resolved');
    const lines = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 30)!);
    expect(lines).toEqual([
      '项目页（Space · 页面更新于 10-21 · 同步于 10-21 10:00）',
      '本周进展：27 Cecil Street 页面上线；补齐户型图',
      '今日：补齐周边配套',
      '当前重点：把 27 Cecil Street 买家空间做成可复用模板',
      '下一步/卡点：卡点 第二套 listing 等 Amy 确认',
      'Space 评论：未解决 3 条（Ivy 1、James 1、其他 1），已解决 1 条'
    ]);
  });

  it('labels first-snapshot progress as page-recorded, not this week', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'first_snapshot', digest: { ...digest, todayProgress: [] } });
    const lines = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 30)!);
    expect(lines).toContain('页面记载进展（首次同步，未区分本周）：27 Cecil Street 页面上线；补齐户型图');
    expect(lines.some((line) => line.startsWith('本周进展'))).toBe(false);
  });

  it('shows a visible gap when the digest failed, and stale wording past the threshold', () => {
    const h = setup();
    h.digests.saveFailed({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, failureCode: 'codex_auth_required' });
    const lines = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, new Date(at.getTime() + 2 * 60 * 60_000), 30)!);
    expect(lines).toContain('Space 内容可能滞后，请以最新 Page 为准');
    expect(lines).toContain('项目页摘要未生成（本地 Codex 需要重新登录）');
  });

  it('never shows an older version\'s digest as current', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    new ContextSourceRepository(h.db.client).saveSource({ sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: 'page_1',
      logicalKey: 'chatgpt_space:page:page_1', occurredAt: '2026-10-21T01:30:00.000Z', authors: [], locatorUri: null,
      contentFormat: 'text/markdown', contentText: '新页面', metadata: { pageId: 'page_1', blocks: [{ id: 'b1', hash: 'b'.repeat(64), markdown: '新页面' }] },
      availabilityStatus: 'available', capturedAt: at });
    const lines = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 30)!);
    expect(lines).toContain('项目页摘要：最新版本摘要生成中，暂不展示旧摘要');
  });

  it('stays out of every founder view until SPACE_SYNC_WORKMAP_ENABLED turns it on', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    const messages = buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'work_map' },
      queryMessageId: 'om_map_off', chatId, approvedChatIds: [chatId], now: at });
    const map = JSON.stringify(messages.map((m) => m.card));
    expect(map).not.toContain('本周进展：27 Cecil Street 页面上线');
    expect(map).not.toContain('项目页（Space');
    expect(map).not.toContain('Space 页面');
    const board = messages.flatMap((m) => m.boardView?.kind === 'work_map' ? m.boardView.topics : []);
    expect(board.some((topic) => 'space' in topic)).toBe(false);
    const progress = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'om_progress_off', chatId, approvedChatIds: [chatId], now: at })[0]!.card);
    expect(progress).not.toContain('当前重点：把 27 Cecil Street 买家空间做成可复用模板');
    expect(progress).not.toContain('Space 页面');
    const on = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'work_map' },
      queryMessageId: 'om_map_on', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true }).map((m) => m.card));
    expect(on).toContain('本周进展：27 Cecil Street 页面上线');
  });

  it('follows the worker flag when a founder asks 查看工作地图 in the group', () => {
    for (const spaceWorkMapEnabled of [false, true]) {
      const h = setup();
      h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
        pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
      new AlignmentRepository(h.db.client).configureFounderIdentity({ founder: 'ivy', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy', configuredAt: at });
      const runtime = createFounderStreamRuntime({ client: h.db.client, jobRepository: new JobRepository(h.db.client),
        flags: { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false, manualQueryEnabled: true },
        approvedChatIds: [chatId], ivyPrivateChatId: 'oc_private', now: () => at, spaceWorkMapEnabled,
        analyzer: { async analyze() { return { topics: [] }; } } });
      expect(runtime.route.ingest({ header: { event_id: 'evt_q', create_time: String(at.getTime()) }, event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_ivy' } }, message: { message_id: 'om_q', chat_id: chatId,
          message_type: 'text', content: JSON.stringify({ text: '@_user_1 查看工作地图' }), create_time: String(at.getTime()) } } }))
        .toMatchObject({ status: 'manual_query_queued' });
      const payloads = (h.db.client.prepare('SELECT payload FROM outbox').all() as { payload: string }[]).map((row) => row.payload).join('\n');
      expect(payloads.includes('本周进展：27 Cecil Street 页面上线')).toBe(spaceWorkMapEnabled);
      h.db.close();
    }
  });

  it('appears in 查看工作地图 under the project card and in 查看项目进展', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    const map = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'work_map' },
      queryMessageId: 'om_map', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true }).map((m) => m.card));
    expect(map).toContain('本周进展：27 Cecil Street 页面上线');
    const progress = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'om_progress', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true })[0]!.card);
    // A digest stored before profiles existed still fills the sections: its focus is what is being worked on now.
    h.db.client.prepare("UPDATE space_project_digests SET digest_json = json_remove(digest_json, '$.profile')").run();
    const legacy = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'om_progress_legacy', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true })[0]!.card);
    expect(legacy).toContain('阶段规划\\n无（页面摘要待更新）');
    expect(legacy).toContain('正在做\\n- 把 27 Cecil Street 买家空间做成可复用模板');
    expect(progress).toContain('阶段规划\\n无（Space 页面没有划分阶段）');
    // The Space status line follows the rest of the processing status: Beijing time, no raw ISO stamps.
    expect(map).toContain('最后成功同步：2026-10-21 10:00');
    expect(map).not.toContain('最后成功同步：2026-10-21T');
  });

  it('lays out 查看项目进展 in Ivy’s order from the page profile only, saying 无 when empty', () => {
    const h = setup();
    const page = (text: string) => ({ text, blockId: 'b1', excerpt: '页面' });
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest: { ...digest, profile: {
        positioning: page('为买家提供可复用的房源空间'),
        phases: [{ ...page('Amy V2 Task 1–9'), name: '能力底座', status: 'done' as const },
          { ...page('27 Cecil Street 样板上线与验收'), name: '样板上线', status: 'current' as const },
          { ...page('复制到第二套房源'), name: '复制推广', status: 'upcoming' as const }],
        completed: [page('27 Cecil Street 页面上线')], inProgress: [page('Task 10 真实验收')], pending: [page('第二套房源选址')],
        problems: [page('家庭数据读取后的最终回复失败')], divergences: [], nextPlan: [page('完成生产切换和回滚演练')] } } });
    const sources = new ContextSourceRepository(h.db.client);
    const captured = captureGroupMessageSource({ chatId, messageId: 'om_done', threadId: null, rootId: null, author: { openId: 'ou_ivy', displayName: null },
      senderType: 'user', messageType: 'text', text: '照片位置笔记已上线', occurredAt: at.toISOString() }, at);
    const source = sources.saveSource(captured.source).source;
    const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: '照片位置笔记已上线', locator: { ...captured.messageLocator,
      sourceVersion: source.sourceVersion, contentHash: source.contentHash }, evidenceLevel: 'primary_statement', capturedAt: at }).evidence.id;
    new AlignmentRepository(h.db.client).savePerspective({ topicId: h.topic.id, kind: 'ivy_view', expectedVersion: 0,
      statement: '照片位置笔记已上线', confidence: 1, evidenceIds: [evidence], decisionKey: 'done', speechAct: 'view', observedAt: at });
    const message = buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'om_progress', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true })[0]!;
    const texts = (message.card.elements as { tag: string; text?: { content?: string } }[]).filter((e) => e.text).map((e) => e.text!.content!);
    expect(texts.slice(0, 8)).toEqual([
      '项目定位\n为买家提供可复用的房源空间\n当前状态：正在推进 · 第 2 阶段：样板上线',
      '阶段规划（共 3 个阶段，目前在第 2 阶段）\n✓ 1. 能力底座：Amy V2 Task 1–9\n▶ 2. 样板上线：27 Cecil Street 样板上线与验收\n○ 3. 复制推广：复制到第二套房源',
      // Ivy 2026-10-22: with a page, keyword-classified group-chat statements stay out of the sections.
      '已完成\n- 27 Cecil Street 页面上线',
      '正在做\n- Task 10 真实验收',
      '待推进\n- 第二套房源选址',
      '卡点与问题\n- 家庭数据读取后的最终回复失败',
      '分歧\n无',
      '下一步计划\n- 完成生产切换和回滚演练']);
    expect(texts[8]).toBe(['资料截至：群聊 尚无已分析消息 · Space 页面 10-21 更新（10-21 10:00 同步）',
      '未标注来源的条目来自 Space 页面。明细发“查看处理状态”。'].join('\n'));
    // No repeated title, no "当前方向", no per-section boilerplate and no long processing-status block.
    const body = JSON.stringify(message.card);
    for (const gone of ['当前方向', '尚未形成明确目标', '群聊记录：', '处理状态（北京时间）', '项目页（Space']) expect(body).not.toContain(gone);
    expect(message.kind === 'founder_manual_query' && message.boardView).toMatchObject({ kind: 'project_progress', title: 'Smart Listing',
      phases: [{ name: '能力底座', status: 'done' }, { name: '样板上线', status: 'current' }, { name: '复制推广', status: 'upcoming' }] });
  });

  it('keeps the group chat in the sections only for a project without a Space page', () => {
    const h = setup();
    const sources = new ContextSourceRepository(h.db.client);
    const captured = captureGroupMessageSource({ chatId, messageId: 'om_done', threadId: null, rootId: null, author: { openId: 'ou_ivy', displayName: null },
      senderType: 'user', messageType: 'text', text: '照片位置笔记已上线', occurredAt: at.toISOString() }, at);
    const source = sources.saveSource(captured.source).source;
    const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: '照片位置笔记已上线', locator: { ...captured.messageLocator,
      sourceVersion: source.sourceVersion, contentHash: source.contentHash }, evidenceLevel: 'primary_statement', capturedAt: at }).evidence.id;
    new AlignmentRepository(h.db.client).savePerspective({ topicId: h.topic.id, kind: 'ivy_view', expectedVersion: 0,
      statement: '照片位置笔记已上线', confidence: 1, evidenceIds: [evidence], decisionKey: 'done', speechAct: 'view', observedAt: at });
    const done = (spaceWorkMapEnabled: boolean) => (buildFounderManualQueryMessages({ client: h.db.client,
      query: { kind: 'project_progress', topicName: 'Smart Listing' }, queryMessageId: `om_${spaceWorkMapEnabled}`, chatId,
      approvedChatIds: [chatId], now: at, spaceWorkMapEnabled })[0]!.card.elements as { text?: { content?: string } }[])
      .map((element) => element.text?.content ?? '').find((text) => text.startsWith('已完成'));
    expect(done(false)).toBe('已完成\n- 照片位置笔记已上线');
    expect(done(true)).toBe('已完成\n无');
  });

  it('falls back to the group chat while the page digest is not ready, and says so once', () => {
    const h = setup();
    const texts = (buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'om_progress', chatId, approvedChatIds: [chatId], now: at, spaceWorkMapEnabled: true })[0]!.card.elements as
      { text?: { content?: string } }[]).map((element) => element.text?.content ?? '');
    expect(texts.find((text) => text.startsWith('项目定位'))).toBe('项目定位\n27 Cecil Street 上线（群聊）\n当前状态：正在推进');
    expect(texts.find((text) => text.startsWith('阶段规划'))).toBe('阶段规划\n无（Space 页面摘要生成中）');
    expect(texts.find((text) => text.startsWith('已完成'))).toBe('已完成\n无');
    expect(texts.find((text) => text.startsWith('资料截至'))).toContain('\nSpace 提示：页面摘要生成中，生成后补上页面内容');
  });

  it('says the digest is being generated when a snapshot exists but no digest is stored yet', () => {
    const h = setup();
    expect(renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 30)!)).toContain('项目页摘要：生成中');
  });

  it('expires "今日" the next day and "本周" the next week instead of freezing them at generation time', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    // 2026-10-22 is the next local day, same week.
    const nextDay = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, new Date('2026-10-22T02:00:00.000Z'), 1440)!);
    expect(nextDay).toContain('本周进展：27 Cecil Street 页面上线；补齐户型图');
    expect(nextDay.some((line) => line.startsWith('今日'))).toBe(false);
    // 2026-10-27 is the following week.
    const nextWeek = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, new Date('2026-10-27T02:00:00.000Z'), 100_000)!);
    expect(nextWeek).toContain('本周页面无更新；上次更新的进展（10-21）：27 Cecil Street 页面上线；补齐户型图');
    expect(nextWeek.some((line) => line.startsWith('本周进展'))).toBe(false);
  });

  it('counts a thread as resolved once a later sync observed it resolved, even though the comment body never changed', () => {
    const h = setup();
    h.comment('m1', 'u_ivy', 'open');
    const spaceSync = new SpaceSyncRepository(h.db.client);
    spaceSync.recordCommentThreadStates({ pageId: 'page_1', observedAt: new Date(at.getTime() + 1_000),
      threads: [{ threadId: 't', threadState: 'resolved', resolvedAt: at.toISOString() }] });
    // An older envelope replayed late cannot reopen it.
    spaceSync.recordCommentThreadStates({ pageId: 'page_1', observedAt: at, threads: [{ threadId: 't', threadState: 'open', resolvedAt: null }] });
    expect(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 30)!.comments).toMatchObject({ open: 0, resolved: 1 });
  });

  it('summarizes the project page for the overview board in one 本周 line plus a dated Space label', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    const view = (now: Date, stale = 1440) => loadSpaceProjectPageView(h.db.client, h.topic.id, now, stale)!;
    expect(spaceBoardSummary(view(at))).toEqual({ weekLine: '本周：27 Cecil Street 页面上线；补齐户型图', label: 'Space · 10-21 更新' });
    expect(spaceBoardSummary(view(new Date('2026-10-23T02:00:00.000Z')))).toEqual({ weekLine: '本周：27 Cecil Street 页面上线；补齐户型图',
      label: 'Space · 10-21 更新 · 可能滞后' });
    expect(spaceBoardSummary(view(new Date('2026-10-27T02:00:00.000Z'), 100_000)).weekLine).toBe('本周：页面无更新');
  });

  it('shows first-snapshot, failed and pending digests honestly on the board', () => {
    const h = setup();
    expect(spaceBoardSummary(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 1440)!).weekLine).toBe('Space 摘要生成中');
    h.digests.saveFailed({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, failureCode: 'codex_execution_failed' });
    expect(spaceBoardSummary(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 1440)!).weekLine).toBe('Space 摘要未生成');
    const h2 = setup();
    h2.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h2.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h2.page.occurredAt, generatedAt: at, changeBasis: 'first_snapshot', digest: { ...digest, todayProgress: [] } });
    expect(spaceBoardSummary(loadSpaceProjectPageView(h2.db.client, h2.topic.id, at, 1440)!).weekLine)
      .toBe('页面记载：27 Cecil Street 页面上线；补齐户型图');
  });
  it('shows Beijing dates and says plainly which part a Markdown import did not cover', () => {
    const h = setup();
    const synced = new Date('2026-10-20T16:54:24.994Z');
    ingestSpaceSyncEnvelope(buildSpaceMarkdownEnvelope({ markdown: '更新于 2026 年 10 月 19 日。页面', projectKey: 'smart-listing',
      page: { pageId: 'page_1', url: 'https://chatgpt.com/space/page_1' }, title: 'Smart Listing', capturedAt: synced }),
    { client: h.db.client, spaceSyncRepository: new SpaceSyncRepository(h.db.client), contextSourceRepository: new ContextSourceRepository(h.db.client),
      limits: { maxBlocks: 500, maxComments: 2000 }, now: () => synced });
    const lines = renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, synced, 24 * 60)!);
    expect(lines[0]).toBe('项目页（Space · 页面更新于 10-19 · 同步于 10-21 00:54）');
    expect(lines).toContain('同步缺口：评论未同步（本次只导入了页面正文），评论里的看法暂未计入');
    expect(lines.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it('names an unknown page date and falls back to plain wording when the gap codes are not stored', () => {
    const h = setup();
    const synced = new Date('2026-10-21T02:00:00.000Z');
    ingestSpaceSyncEnvelope(buildSpaceMarkdownEnvelope({ markdown: '页面', projectKey: 'smart-listing',
      page: { pageId: 'page_1', url: 'https://chatgpt.com/space/page_1' }, title: 'Smart Listing', capturedAt: synced }),
    { client: h.db.client, spaceSyncRepository: new SpaceSyncRepository(h.db.client), contextSourceRepository: new ContextSourceRepository(h.db.client),
      limits: { maxBlocks: 500, maxComments: 2000 }, now: () => synced });
    const view = loadSpaceProjectPageView(h.db.client, h.topic.id, synced, 24 * 60)!;
    expect(renderSpaceProjectPageLines(view)).toContain('同步缺口：评论未同步（本次只导入了页面正文），评论里的看法暂未计入；页面更新时间未知');
    const legacy = { ...view, syncGaps: undefined, freshness: { ...view.freshness, coverageIncomplete: true, gapCount: 2 } };
    expect(renderSpaceProjectPageLines(legacy)).toContain('同步缺口：有 2 处内容未同步，未同步的部分不计入进展');
  });
});
