import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import {
  buildFounderStreamInput, createFounderStreamRuntime, saveFounderEvidence
} from '../src/services/founder-stream-worker.js';
import { loadSpaceBatchSources } from '../src/services/space-batch-processor.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { SpaceProjectDigestRepository } from '../src/repositories/space-project-digest-repository.js';
import type { SpaceProjectDigestInput } from '../src/services/space-project-digest.js';

const start = new Date('2026-10-19T00:00:00.000Z');
const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  for (const [key, name] of [['smart_listing', 'Smart Listing'], ['other_project', 'Other']] as const)
    db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
      VALUES (?, ?, '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(key, name, start.toISOString(), start.toISOString());
  const jobs = new JobRepository(db.client);
  const sources = new ContextSourceRepository(db.client);
  const topics = new TopicRepository(db.client);
  const spaceSync = new SpaceSyncRepository(db.client);
  const bindings = new FounderTopicProjectBindingRepository(db.client);
  spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: start });
  return { db, jobs, sources, topics, spaceSync, bindings };
}

function canonicalTopic(h: ReturnType<typeof setup>, source: 'human' | 'analysis' = 'human') {
  const feishu = h.sources.saveSource(captureGroupMessageSource({ chatId: chat, messageId: 'om_baseline', threadId: null,
    rootId: null, author: { openId: 'ou_ivy', displayName: null }, messageType: 'text', senderType: 'user',
    text: 'Smart Listing 推进 27 Cecil Street', occurredAt: start.toISOString() }, start).source).source;
  const evidenceId = saveFounderEvidence(h.sources, feishu.id, feishu.contentText, start);
  const topic = h.topics.createTopic({ displayName: 'Smart Listing', stage: 'active_project', outcome: '27 Cecil Street 上线',
    evidenceIds: [evidenceId], createdAt: start });
  if (source === 'human') h.bindings.recordHumanConfirmed({ topicId: topic.id, projectKey: 'smart_listing', role: 'canonical', at: start });
  else h.bindings.proposeFromAnalysis({ topicId: topic.id, projectKey: 'smart_listing', role: 'canonical', at: start });
  return topic;
}

function spacePageSource(sources: ContextSourceRepository, overrides: { pageId?: string; text?: string; occurredAt?: string } = {}) {
  const pageId = overrides.pageId ?? 'page_1';
  const text = overrides.text ?? 'Smart Listing 项目总览';
  return sources.saveSource({
    sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: pageId,
    logicalKey: `chatgpt_space:page:${pageId}`, occurredAt: overrides.occurredAt ?? start.toISOString(),
    authors: [], locatorUri: `https://chatgpt.com/space/${pageId}`, contentFormat: 'text/markdown',
    contentText: text, metadata: { pageId, title: 'Smart Listing', blocks: [{ id: 'block_1', hash: 'a'.repeat(64), markdown: text }] },
    availabilityStatus: 'available', capturedAt: start
  }).source;
}

function spaceCommentSource(sources: ContextSourceRepository, overrides: { pageId?: string; text?: string; messageId?: string;
  authorId?: string; threadState?: 'open' | 'resolved' } = {}) {
  const pageId = overrides.pageId ?? 'page_1';
  const messageId = overrides.messageId ?? 'msg_1';
  const authorId = overrides.authorId ?? 'space_user_ivy';
  return sources.saveSource({
    sourceSystem: 'chatgpt_space', sourceType: 'space_page_comment', externalId: messageId,
    logicalKey: `chatgpt_space:page:${pageId}:thread:thread_1:message:${messageId}`, occurredAt: start.toISOString(),
    authors: [{ openId: authorId, displayName: null }], locatorUri: `https://chatgpt.com/space/${pageId}`,
    contentFormat: 'text/plain', contentText: overrides.text ?? '需要补充负责人',
    metadata: { pageId, threadId: 'thread_1', messageId, authorOpenId: authorId, targetBlockId: null,
      threadState: overrides.threadState ?? 'open', resolvedAt: overrides.threadState === 'resolved' ? start.toISOString() : null },
    availabilityStatus: 'available', capturedAt: start
  }).source;
}

describe('loadSpaceBatchSources admission', () => {
  it('admits a space page/comment source whose binding matches the requested projectKey', () => {
    const h = setup();
    const page = spacePageSource(h.sources);
    const comment = spaceCommentSource(h.sources);
    const loaded = loadSpaceBatchSources(h.sources, h.spaceSync, [page.id, comment.id], 'smart_listing');
    expect(loaded.pages.map((s) => s.id)).toEqual([page.id]);
    expect(loaded.comments.map((s) => s.id)).toEqual([comment.id]);
  });

  it('rejects a source whose page is bound to a different project', () => {
    const h = setup();
    h.spaceSync.createBinding({ id: 'binding-2', projectKey: 'other_project', spaceId: null, pageId: 'page_2',
      pageUrl: 'https://chatgpt.com/space/page_2', managementMode: 'space', syncMode: 'manual', createdAt: start });
    const page = spacePageSource(h.sources, { pageId: 'page_2' });
    expect(() => loadSpaceBatchSources(h.sources, h.spaceSync, [page.id], 'smart_listing')).toThrow();
  });

  it('rejects a source whose page has no binding at all', () => {
    const h = setup();
    const page = spacePageSource(h.sources, { pageId: 'page_unregistered' });
    expect(() => loadSpaceBatchSources(h.sources, h.spaceSync, [page.id], 'smart_listing')).toThrow();
  });

  it('rejects a group_message source even when its id is passed to the space loader', () => {
    const h = setup();
    const source = h.sources.saveSource(captureGroupMessageSource({ chatId: chat, messageId: 'om_1', threadId: null, rootId: null,
      author: { openId: 'ou_ivy', displayName: null }, messageType: 'text', senderType: 'user', text: '知识库',
      occurredAt: start.toISOString() }, start).source).source;
    expect(() => loadSpaceBatchSources(h.sources, h.spaceSync, [source.id], 'smart_listing')).toThrow();
  });

  it('never leaks a Space source into the chatId-scoped builder, even if its id is passed in', () => {
    const h = setup();
    const page = spacePageSource(h.sources);
    expect(() => buildFounderStreamInput(h.sources, h.topics, [page.id], chat)).toThrow();
  });
});

function harness(spaceAnalysisEnabled = true) {
  const h = setup();
  let now = start;
  const topicAnalyzerCalls: unknown[] = [];
  const runtime = createFounderStreamRuntime({
    client: h.db.client, jobRepository: h.jobs,
    flags: { captureEnabled: false, analysisEnabled: false, groupDeliveryEnabled: false },
    approvedChatIds: [], ivyPrivateChatId: 'oc_private', now: () => now, spaceAnalysisEnabled,
    // Space content must never go through topic extraction; any call here is a regression.
    analyzer: { async analyze(input) { topicAnalyzerCalls.push(input); return { topics: [] }; } }
  });
  return { ...h, runtime, now: () => now, setNow: (value: Date) => { now = value; }, topicAnalyzerCalls };
}

function jobStatus(h: ReturnType<typeof harness>, key: string) {
  return (h.db.client.prepare('SELECT status FROM batch_jobs WHERE stable_key=?').get(key) as { status: string }).status;
}

describe('founder-stream-worker Space-scoped processing', () => {
  it('waits (retry) and creates nothing when the project has no confirmed canonical work-map topic', async () => {
    const h = harness();
    const page = spacePageSource(h.sources);
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: start.toISOString(), sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(jobStatus(h, queued.key)).toBe('retry');
    expect(h.topics.listCurrentTopics()).toHaveLength(0);
    expect(h.bindings.listForProject('smart_listing')).toEqual([]);
  });

  it('does not trust an analysis-proposed canonical binding as the Space target', async () => {
    const h = harness();
    canonicalTopic(h, 'analysis');
    const comment = spaceCommentSource(h.sources);
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: start.toISOString(), sourceIds: [comment.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(jobStatus(h, queued.key)).toBe('retry');
    expect(h.topics.listCurrentTopics()[0]!.currentVersion).toBe(1);
  });

  it('rejects a Space batch for a projectKey with no registered page binding', async () => {
    const h = harness();
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'unregistered_project', since: start.toISOString(),
      until: start.toISOString(), sourceIds: ['ctxsrc_missing'], capturedAt: start });
    await h.runtime.runOnce();
    expect(jobStatus(h, queued.key)).toBe('retry');
  });

  it('never runs topic extraction on page content and never creates, renames or restages a topic', async () => {
    const h = harness();
    const topic = canonicalTopic(h);
    const page = spacePageSource(h.sources, { text: '完全不同的名字：Smart Listing 2.0，阶段已关闭' });
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: start.toISOString(), sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(jobStatus(h, queued.key)).toBe('completed');
    expect(h.topicAnalyzerCalls).toHaveLength(0);
    expect(h.topics.listCurrentTopics()).toHaveLength(1);
    expect(h.topics.listCurrentTopics()[0]).toMatchObject({ id: topic.id, displayName: 'Smart Listing',
      stage: 'active_project', outcome: '27 Cecil Street 上线' });
  });

  it('attaches comment evidence to the canonical topic while preserving its name, stage and outcome', async () => {
    const h = harness();
    const topic = canonicalTopic(h);
    const comment = spaceCommentSource(h.sources, { text: '第二套 listing 先等 Amy 确认' });
    h.setNow(new Date(start.getTime() + 1_000));
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: h.now().toISOString(), sourceIds: [comment.id], capturedAt: h.now() });
    await h.runtime.runOnce();
    const current = h.topics.listCurrentTopics().find((t) => t.id === topic.id)!;
    expect(current).toMatchObject({ currentVersion: 2, displayName: 'Smart Listing', stage: 'active_project', outcome: '27 Cecil Street 上线' });
    const commentEvidence = current.evidenceIds.map((id) => h.sources.getEvidence(id)!).find((e) => e.sourceId === comment.id);
    expect(commentEvidence).toMatchObject({ excerpt: '第二套 listing 先等 Amy 确认', locator: { kind: 'space_comment' } });
    expect(JSON.parse(h.topics.listVersions(topic.id).at(-1)!.rationale)).toMatchObject({ origin: 'space_sync', projectKey: 'smart_listing' });
  });

  it('keeps a human-paused canonical topic paused when Space comments arrive', async () => {
    const h = harness();
    const topic = canonicalTopic(h);
    h.topics.appendVersion({ topicId: topic.id, expectedVersion: 1, displayName: 'Smart Listing', stage: 'paused',
      outcome: '人工暂停', rationale: 'manual', evidenceIds: topic.evidenceIds, changedAt: start });
    const comment = spaceCommentSource(h.sources, { text: '继续推进吧' });
    h.setNow(new Date(start.getTime() + 1_000));
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: h.now().toISOString(), sourceIds: [comment.id], capturedAt: h.now() });
    await h.runtime.runOnce();
    expect(h.topics.listCurrentTopics()[0]).toMatchObject({ stage: 'paused', outcome: '人工暂停' });
  });

  it('never proposes an analysis-sourced project binding', async () => {
    const h = harness();
    canonicalTopic(h);
    const comment = spaceCommentSource(h.sources);
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: start.toISOString(), sourceIds: [comment.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.bindings.listForProject('smart_listing').map((b) => b.source)).toEqual(['human_confirmed']);
  });

  it('is not leased at all when spaceAnalysisEnabled is left off (default)', async () => {
    const h = harness(false);
    canonicalTopic(h);
    const page = spacePageSource(h.sources);
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.db.client.prepare("SELECT status FROM batch_jobs").get()).toEqual({ status: 'queued' });
  });

  it('splits a Space batch of more than 20 sources into bounded durable sub-batches', async () => {
    const h = harness();
    const ids = Array.from({ length: 25 }, (_, i) => `ctxsrc_space_${i}`);
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: ids, capturedAt: start });
    await h.runtime.runOnce();
    const rows = h.db.client.prepare("SELECT payload FROM batch_jobs WHERE status='queued'").all() as { payload: string }[];
    expect(rows.length).toBeGreaterThan(1);
    const chunks = rows.map((r) => JSON.parse(r.payload).sourceIds as string[]);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    expect(chunks.flat().sort()).toEqual(ids.slice().sort());
  });

  it('recovery leaves sources unclaimed until a confirmed topic mapping exists, then enqueues them once', async () => {
    const h = harness();
    const page = spacePageSource(h.sources, { text: 'Smart Listing 恢复案例' });
    await h.runtime.afterTick();
    expect(h.db.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'").get()).toEqual({ n: 0 });

    canonicalTopic(h);
    const claimed = spaceCommentSource(h.sources, { messageId: 'msg_claimed', text: '已有分析任务引用' });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [claimed.id], capturedAt: start });
    await h.runtime.afterTick();
    const rows = h.db.client.prepare("SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'")
      .all() as { payload: string }[];
    const allSourceIds = rows.flatMap((r) => JSON.parse(r.payload).sourceIds as string[]);
    expect(allSourceIds).toContain(page.id);
    expect(allSourceIds.filter((id) => id === claimed.id)).toHaveLength(1);
  });
});

describe('Space project-page digest per page version', () => {
  function digestHarness(digest: (input: SpaceProjectDigestInput) => Promise<unknown>) {
    const h = setup();
    const calls: SpaceProjectDigestInput[] = [];
    const runtime = createFounderStreamRuntime({
      client: h.db.client, jobRepository: h.jobs,
      flags: { captureEnabled: false, analysisEnabled: false, groupDeliveryEnabled: false },
      approvedChatIds: [], ivyPrivateChatId: 'oc_private', now: () => start, spaceAnalysisEnabled: true,
      spaceDigestAnalyzer: { async digest(input) { calls.push(input); return await digest(input) as never; } }
    });
    return { ...h, runtime, calls, digests: new SpaceProjectDigestRepository(h.db.client) };
  }

  it('stores a grounded digest for the latest page version without touching the topic', async () => {
    const h = digestHarness(async (input) => ({ currentFocus: { text: '项目总览', blockId: input.blocks[0]!.id, excerpt: '项目总览' },
      weekProgress: [], todayProgress: [], nextSteps: [] }));
    const topic = canonicalTopic(h);
    const page = spacePageSource(h.sources);
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.calls[0]).toMatchObject({ projectName: 'Smart Listing', changeBasis: 'first_snapshot' });
    expect(h.digests.getLatestForProject('smart_listing')).toMatchObject({ status: 'ready', pageSourceId: page.id,
      changeBasis: 'first_snapshot', digest: { currentFocus: { excerpt: '项目总览' } } });
    expect(h.topics.listCurrentTopics()[0]).toMatchObject({ id: topic.id, currentVersion: 1 });
  });

  it('retries a failing digest, then records a visible failure gap and completes', async () => {
    const h = digestHarness(async () => { throw Object.assign(new Error('codex down'), { code: 'CODEX_EXECUTION_FAILED' }); });
    canonicalTopic(h);
    const page = spacePageSource(h.sources);
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(jobStatus(h as never, queued.key)).toBe('retry');
    expect(h.digests.getLatestForProject('smart_listing')).toBeNull();
    h.db.client.prepare("UPDATE batch_jobs SET payload=json_set(payload,'$.attempt',2), updated_at=? WHERE stable_key=?")
      .run(start.toISOString(), queued.key);
    await h.runtime.runOnce();
    expect(jobStatus(h as never, queued.key)).toBe('completed');
    expect(h.digests.getLatestForProject('smart_listing')).toMatchObject({ status: 'failed', failureCode: 'codex_execution_failed' });
  });

  it('records analyzer_unavailable when no digest analyzer is configured', async () => {
    const h = harness();
    canonicalTopic(h);
    const page = spacePageSource(h.sources);
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(new SpaceProjectDigestRepository(h.db.client).getLatestForProject('smart_listing'))
      .toMatchObject({ status: 'failed', failureCode: 'analyzer_unavailable' });
  });

  it('skips a superseded page version replayed late', async () => {
    const h = digestHarness(async () => ({ currentFocus: null, weekProgress: [], todayProgress: [], nextSteps: [] }));
    canonicalTopic(h);
    const old = spacePageSource(h.sources, { text: '旧版本' });
    spacePageSource(h.sources, { text: '新版本', occurredAt: new Date(start.getTime() + 1_000).toISOString() });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [old.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.calls).toHaveLength(0);
    expect(h.digests.getForPageSource(old.id)).toBeNull();
  });
});

describe('Space comments feed the shared perspective/alignment mechanism', () => {
  type PerspectiveInput = Parameters<NonNullable<Parameters<typeof createFounderStreamRuntime>[0]['perspectiveAnalyzer']>['analyze']>[0];
  function perspectiveHarness(respond: (input: PerspectiveInput) => Awaited<ReturnType<NonNullable<Parameters<typeof createFounderStreamRuntime>[0]['perspectiveAnalyzer']>['analyze']>>) {
    const h = setup();
    const alignment = new AlignmentRepository(h.db.client);
    alignment.configureFounderIdentity({ founder: 'ivy', sourceSystem: 'chatgpt_space', externalAuthorId: 'space_user_ivy', configuredAt: start });
    alignment.configureFounderIdentity({ founder: 'james', sourceSystem: 'chatgpt_space', externalAuthorId: 'space_user_james', configuredAt: start });
    const inputs: PerspectiveInput[] = [];
    const runtime = createFounderStreamRuntime({
      client: h.db.client, jobRepository: h.jobs,
      flags: { captureEnabled: false, analysisEnabled: false, groupDeliveryEnabled: false },
      approvedChatIds: [], ivyPrivateChatId: 'oc_private', now: () => start, spaceAnalysisEnabled: true,
      perspectiveAnalyzer: { async analyze(input) { inputs.push(input); return respond(input); } }
    });
    return { ...h, runtime, inputs, alignment };
  }

  it('attributes comment authors via chatgpt_space identities and skips resolved threads', async () => {
    const h = perspectiveHarness(() => ({ observations: [], alignmentProposals: [] }));
    const topic = canonicalTopic(h);
    const ivy = spaceCommentSource(h.sources, { messageId: 'msg_ivy', text: '先做 27 Cecil Street' });
    const james = spaceCommentSource(h.sources, { messageId: 'msg_james', authorId: 'space_user_james', text: '同意先做 27 Cecil Street' });
    const stranger = spaceCommentSource(h.sources, { messageId: 'msg_agent', authorId: 'space_agent_x', text: 'agent 备注' });
    const resolved = spaceCommentSource(h.sources, { messageId: 'msg_old', threadState: 'resolved', text: '旧讨论' });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [ivy.id, james.id, stranger.id, resolved.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]!.topicIds).toEqual([topic.id]);
    expect(new Map(h.inputs[0]!.evidence.map((e) => [e.sourceId, e.founder]))).toEqual(new Map<string, string | null>([[ivy.id, 'ivy'], [james.id, 'james'], [stranger.id, null]]));
    // Resolved threads remain on the card as historical evidence.
    const evidenceSources = h.topics.listCurrentTopics()[0]!.evidenceIds.map((id) => h.sources.getEvidence(id)!.sourceId);
    expect(evidenceSources).toContain(resolved.id);
  });

  it('can record consensus from explicit statements by both founders (comments are not forced into divergence)', async () => {
    const h = perspectiveHarness((input) => ({ alignmentProposals: [], observations: input.evidence.filter((e) => e.founder).map((e) => ({
      topicId: input.topicIds[0]!, evidenceId: e.id, statement: e.excerpt, speechAct: e.founder === 'ivy' ? 'decision_proposal' as const : 'explicit_agreement' as const,
      decisionKey: 'first-listing', confidence: 1, observedAt: new Date(e.occurredAt) })) }));
    const topic = canonicalTopic(h);
    const ivy = spaceCommentSource(h.sources, { messageId: 'msg_ivy', text: '先做 27 Cecil Street' });
    const james = spaceCommentSource(h.sources, { messageId: 'msg_james', authorId: 'space_user_james', text: '同意先做 27 Cecil Street' });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [ivy.id, james.id], capturedAt: start });
    await h.runtime.runOnce();
    const kinds = h.alignment.listCurrentPerspectives(topic.id).map((p) => p.kind).sort();
    expect(kinds).toContain('ivy_view');
    expect(kinds).toContain('james_view');
  });

  it('records a grounded divergence as a 查看分歧 candidate without sending any Feishu message', async () => {
    const h = perspectiveHarness((input) => {
      const ivy = input.evidence.find((e) => e.founder === 'ivy')!, james = input.evidence.find((e) => e.founder === 'james')!;
      return { observations: [ivy, james].map((e) => ({ topicId: input.topicIds[0]!, evidenceId: e.id, statement: e.excerpt,
        speechAct: 'view' as const, decisionKey: 'first-listing', confidence: 1, observedAt: new Date(e.occurredAt) })),
      alignmentProposals: [{ topicId: input.topicIds[0]!, decisionKey: 'first-listing', dimension: 'direction',
        ivy: { evidenceId: ivy.id, statement: '先做 27 Cecil Street' }, james: { evidenceId: james.id, statement: '先做第二套 listing' },
        actionConsequence: null, actionHorizon: null }] };
    });
    canonicalTopic(h);
    const ivy = spaceCommentSource(h.sources, { messageId: 'msg_ivy', text: '先做 27 Cecil Street' });
    const james = spaceCommentSource(h.sources, { messageId: 'msg_james', authorId: 'space_user_james', text: '先做第二套 listing' });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [ivy.id, james.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.db.client.prepare("SELECT status FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'").get()).toEqual({ status: 'completed' });
    expect(h.db.client.prepare('SELECT count(*) n FROM outbox').get()).toEqual({ n: 0 });
  });
});

describe('Space digest grounding is enforced by the worker, not only by the Codex adapter', () => {
  it('records space_digest_invalid when an analyzer claims an ungrounded excerpt', async () => {
    const h = setup();
    const runtime = createFounderStreamRuntime({
      client: h.db.client, jobRepository: h.jobs,
      flags: { captureEnabled: false, analysisEnabled: false, groupDeliveryEnabled: false },
      approvedChatIds: [], ivyPrivateChatId: 'oc_private', now: () => start, spaceAnalysisEnabled: true,
      spaceDigestAnalyzer: { async digest(input) { return { currentFocus: { text: 'x', blockId: input.blocks[0]!.id, excerpt: '页面没有这句话' },
        weekProgress: [], todayProgress: [], nextSteps: [] }; } }
    });
    canonicalTopic(h);
    const page = spacePageSource(h.sources);
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [page.id], capturedAt: start });
    h.db.client.prepare("UPDATE batch_jobs SET payload=json_set(payload,'$.attempt',2) WHERE stable_key=?").run(queued.key);
    await runtime.runOnce();
    expect(new SpaceProjectDigestRepository(h.db.client).getLatestForProject('smart_listing'))
      .toMatchObject({ status: 'failed', failureCode: 'space_digest_invalid' });
  });
});
