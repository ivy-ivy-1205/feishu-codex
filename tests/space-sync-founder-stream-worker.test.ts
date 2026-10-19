import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import {
  buildFounderStreamInput, buildFounderStreamSpaceInput, createFounderStreamRuntime, saveFounderEvidence
} from '../src/services/founder-stream-worker.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

const start = new Date('2026-10-19T00:00:00.000Z');
const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`)
    .run(start.toISOString(), start.toISOString());
  db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('other_project', 'Other', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`)
    .run(start.toISOString(), start.toISOString());
  const jobs = new JobRepository(db.client);
  const sources = new ContextSourceRepository(db.client);
  const topics = new TopicRepository(db.client);
  const spaceSync = new SpaceSyncRepository(db.client);
  spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: start });
  return { db, jobs, sources, topics, spaceSync };
}

function spacePageSource(sources: ContextSourceRepository, overrides: { pageId?: string; text?: string; occurredAt?: string } = {}) {
  const pageId = overrides.pageId ?? 'page_1';
  const text = overrides.text ?? 'Smart Listing 项目总览';
  return sources.saveSource({
    sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: pageId,
    logicalKey: `chatgpt_space:page:${pageId}`, occurredAt: overrides.occurredAt ?? start.toISOString(),
    authors: [], locatorUri: `https://chatgpt.com/space/${pageId}`, contentFormat: 'text/markdown',
    contentText: text, metadata: { pageId, blocks: [{ id: 'block_1', hash: 'a'.repeat(64), markdown: text }] },
    availabilityStatus: 'available', capturedAt: start
  }).source;
}

function spaceCommentSource(sources: ContextSourceRepository, overrides: { pageId?: string; text?: string; messageId?: string } = {}) {
  const pageId = overrides.pageId ?? 'page_1';
  const messageId = overrides.messageId ?? 'msg_1';
  return sources.saveSource({
    sourceSystem: 'chatgpt_space', sourceType: 'space_page_comment', externalId: messageId,
    logicalKey: `chatgpt_space:page:${pageId}:thread:thread_1:message:${messageId}`, occurredAt: start.toISOString(),
    authors: [{ openId: 'ou_ivy', displayName: 'Ivy' }], locatorUri: `https://chatgpt.com/space/${pageId}`,
    contentFormat: 'text/plain', contentText: overrides.text ?? '需要补充负责人',
    metadata: { pageId, threadId: 'thread_1', messageId, authorOpenId: 'ou_ivy', targetBlockId: null },
    availabilityStatus: 'available', capturedAt: start
  }).source;
}

describe('buildFounderStreamSpaceInput admission', () => {
  it('admits a space page/comment source whose binding matches the requested projectKey', () => {
    const h = setup();
    const page = spacePageSource(h.sources);
    const comment = spaceCommentSource(h.sources);
    const input = buildFounderStreamSpaceInput(h.sources, h.topics, h.spaceSync, [page.id, comment.id], 'smart_listing');
    expect(input.sources.map((s) => s.id).sort()).toEqual([comment.id, page.id].sort());
  });

  it('rejects a source whose page is bound to a different project', () => {
    const h = setup();
    h.spaceSync.createBinding({ id: 'binding-2', projectKey: 'other_project', spaceId: null, pageId: 'page_2',
      pageUrl: 'https://chatgpt.com/space/page_2', managementMode: 'space', syncMode: 'manual', createdAt: start });
    const page = spacePageSource(h.sources, { pageId: 'page_2' });
    expect(() => buildFounderStreamSpaceInput(h.sources, h.topics, h.spaceSync, [page.id], 'smart_listing')).toThrow();
  });

  it('rejects a source whose page has no binding at all', () => {
    const h = setup();
    const page = spacePageSource(h.sources, { pageId: 'page_unregistered' });
    expect(() => buildFounderStreamSpaceInput(h.sources, h.topics, h.spaceSync, [page.id], 'smart_listing')).toThrow();
  });

  it('rejects a group_message source even when its id is passed to the space builder', () => {
    const h = setup();
    const source = h.sources.saveSource(captureGroupMessageSource({ chatId: chat, messageId: 'om_1', threadId: null, rootId: null,
      author: { openId: 'ou_ivy', displayName: null }, messageType: 'text', senderType: 'user', text: '知识库',
      occurredAt: start.toISOString() }, start).source).source;
    expect(() => buildFounderStreamSpaceInput(h.sources, h.topics, h.spaceSync, [source.id], 'smart_listing')).toThrow();
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
  const inputs: { projectKey?: string }[] = [];
  const runtime = createFounderStreamRuntime({
    client: h.db.client, jobRepository: h.jobs,
    flags: { captureEnabled: false, analysisEnabled: false, groupDeliveryEnabled: false },
    approvedChatIds: [], ivyPrivateChatId: 'oc_private', now: () => now, spaceAnalysisEnabled,
    analyzer: { async analyze(input) { inputs.push({}); return { topics: [{
      displayName: 'Smart Listing', stage: 'active_project', outcome: '项目总览', currentAction: 'Smart Listing',
      confidence: 'high', sourceIds: [input.sources[0]!.id],
      evidenceExcerpts: [{ sourceId: input.sources[0]!.id, excerpt: input.sources[0]!.contentText }],
      joinDecision: input.currentTopics.length ? { kind: 'exact_continuation', topicId: input.currentTopics[0]!.id,
        confidence: 'high', sharedTerms: ['Smart Listing'] } : { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] },
      splitSuggestions: []
    }] }; } }
  });
  return { ...h, runtime, now: () => now, setNow: (value: Date) => { now = value; }, inputs };
}

describe('founder-stream-worker Space-scoped processing', () => {
  it('admits and persists a new topic from a Space batch without any approved chatId', async () => {
    const h = harness();
    const page = spacePageSource(h.sources);
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(),
      until: start.toISOString(), sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    const row = h.db.client.prepare('SELECT status FROM batch_jobs WHERE stable_key=?').get(queued.key) as { status: string };
    expect(row.status).toBe('completed');
    expect(h.topics.listCurrentTopics()).toHaveLength(1);
    expect(h.topics.listCurrentTopics()[0]).toMatchObject({ displayName: 'Smart Listing', stage: 'active_project' });
  });

  it('rejects a Space batch for a projectKey with no registered binding', async () => {
    const h = harness();
    const queued = h.jobs.enqueueSpaceStreamBatch({ projectKey: 'unregistered_project', since: start.toISOString(),
      until: start.toISOString(), sourceIds: ['ctxsrc_missing'], capturedAt: start });
    await h.runtime.runOnce();
    const row = h.db.client.prepare('SELECT status FROM batch_jobs WHERE stable_key=?').get(queued.key) as { status: string };
    expect(row.status).toBe('retry');
    expect(h.topics.listCurrentTopics()).toHaveLength(0);
  });

  it('is not leased at all when spaceAnalysisEnabled is left off (default)', async () => {
    const h = harness(false);
    const page = spacePageSource(h.sources);
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [page.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.topics.listCurrentTopics()).toHaveLength(0);
    expect(h.db.client.prepare("SELECT status FROM batch_jobs").get()).toEqual({ status: 'queued' });
  });

  it('continues (joins) the existing canonical topic on a later Space batch instead of duplicating it', async () => {
    const h = harness();
    const first = spacePageSource(h.sources, { text: 'Smart Listing 项目总览 V1' });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [first.id], capturedAt: start });
    await h.runtime.runOnce();
    expect(h.topics.listCurrentTopics()).toHaveLength(1);
    const originalId = h.topics.listCurrentTopics()[0]!.id;

    const second = spacePageSource(h.sources, { text: 'Smart Listing 项目总览 V2',
      occurredAt: new Date(start.getTime() + 1_000).toISOString() });
    h.setNow(new Date(start.getTime() + 2_000));
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: h.now().toISOString(),
      sourceIds: [second.id], capturedAt: h.now() });
    await h.runtime.runOnce();

    expect(h.topics.listCurrentTopics()).toHaveLength(1);
    expect(h.topics.listCurrentTopics()[0]!.id).toBe(originalId);
    expect(h.topics.listCurrentTopics()[0]!.currentVersion).toBe(2);
  });

  it('protects a human-corrected topic from being overwritten by a later Space batch, same as the Feishu path', async () => {
    const h = harness();
    const source = h.sources.saveSource(captureGroupMessageSource({ chatId: chat, messageId: 'om_baseline', threadId: null,
      rootId: null, author: { openId: 'ou_ivy', displayName: null }, messageType: 'text', senderType: 'user',
      text: 'Smart Listing', occurredAt: start.toISOString() }, start).source).source;
    const evidenceId = saveFounderEvidence(h.sources, source.id, source.contentText, start);
    const topic = h.topics.createTopic({ displayName: 'Smart Listing', stage: 'paused', outcome: '人工暂停',
      evidenceIds: [evidenceId], createdAt: start });
    h.db.client.prepare(`INSERT INTO founder_feedback_corrections
      (id, chat_id, source_message_id, author_open_id, binding_message_id, evidence_id, input_hash, correction_json, result_json, created_at)
      VALUES ('feedback_1', ?, 'om_baseline', 'ou_ivy', 'om_baseline', ?, 'hash', ?, '{"status":"applied"}', ?)`)
      .run(chat, evidenceId, JSON.stringify({ kind: 'pause_topic', topic: { id: topic.id, expectedVersion: 1 } }), start.toISOString());

    const page = spacePageSource(h.sources, { occurredAt: new Date(start.getTime() + 1_000).toISOString() });
    h.setNow(new Date(start.getTime() + 2_000));
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: h.now().toISOString(),
      sourceIds: [page.id], capturedAt: h.now() });
    await h.runtime.runOnce();

    const current = h.topics.listCurrentTopics().find((t) => t.id === topic.id)!;
    expect(current.stage).toBe('paused');
    expect(current.outcome).toBe('人工暂停');
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

  it('recovers an un-enqueued Space source on afterTick and does not re-enqueue an already-claimed one', async () => {
    const h = harness();
    const unclaimed = spacePageSource(h.sources, { pageId: 'page_1', text: 'Smart Listing 恢复案例' });
    const claimed = spaceCommentSource(h.sources, { messageId: 'msg_claimed', text: '已有分析任务引用' });
    h.jobs.enqueueSpaceStreamBatch({ projectKey: 'smart_listing', since: start.toISOString(), until: start.toISOString(),
      sourceIds: [claimed.id], capturedAt: start });

    await h.runtime.afterTick();

    const rows = h.db.client.prepare("SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'")
      .all() as { payload: string }[];
    const allSourceIds = rows.flatMap((r) => JSON.parse(r.payload).sourceIds as string[]);
    expect(allSourceIds).toContain(unclaimed.id);
    expect(allSourceIds.filter((id) => id === claimed.id)).toHaveLength(1);
  });
});
