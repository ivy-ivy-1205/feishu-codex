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
import { loadSpaceProjectPageView, renderSpaceProjectPageLines } from '../src/services/space-project-page-view.js';

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
  nextSteps: [{ kind: 'blocker' as const, text: '第二套 listing 等 Amy 确认', blockId: 'b1', excerpt: '页面' }]
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
      '项目页（Space · 页面更新于 2026-10-21T01:00:00.000Z · 同步于 2026-10-21T02:00:00.000Z）',
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

  it('appears in 查看工作地图 under the project card and in 查看项目进展', () => {
    const h = setup();
    h.digests.saveReady({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: h.page.id, pageSourceVersion: 1,
      pageUpdatedAt: h.page.occurredAt, generatedAt: at, changeBasis: 'version_diff', digest });
    const map = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'work_map' },
      queryMessageId: 'om_map', chatId, approvedChatIds: [chatId], now: at }).map((m) => m.card));
    expect(map).toContain('本周进展：27 Cecil Street 页面上线');
    const progress = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'project_progress', topicName: 'Smart Listing' },
      queryMessageId: 'om_progress', chatId, approvedChatIds: [chatId], now: at })[0]!.card);
    expect(progress).toContain('当前重点：把 27 Cecil Street 买家空间做成可复用模板');
  });

  it('says the digest is being generated when a snapshot exists but no digest is stored yet', () => {
    const h = setup();
    expect(renderSpaceProjectPageLines(loadSpaceProjectPageView(h.db.client, h.topic.id, at, 30)!)).toContain('项目页摘要：生成中');
  });
});
