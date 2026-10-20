import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import { renderFounderWorkMap } from '../src/services/founder-work-map-renderer.js';

const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';
const feedbackNow = new Date('2026-09-21T10:00:00.000Z');

/** The worker only listens to the approved founders group, so this harness delivers a work-map card there. */
function harness() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  new AlignmentRepository(db.client).configureFounderIdentity({ founder: 'ivy', sourceSystem: 'feishu', externalAuthorId: 'ou_ivy', configuredAt: feedbackNow });
  const topics = new TopicRepository(db.client);
  const created = Array.from({ length: 4 }, (_, i) => topics.createTopic({ displayName: `话题${i}`, stage: 'active_project', createdAt: feedbackNow }));
  const map = renderFounderWorkMap({ since: '2026-09-01T10:00:00.000Z', until: feedbackNow.toISOString(),
    topics: created.map((t) => ({ ...t, evidence: [] })), uncertainGrouping: [], coverageGaps: [] })[0]!;
  const outbox = new OutboxRepository(db.client);
  outbox.enqueueFounderWorkMap({ ...map, mapId: 'map_fixture', targetChatId: chatId }, feedbackNow);
  outbox.acknowledgeFounderWorkMapDelivery({ mapId: 'map_fixture', page: 1, messageId: 'om_map', deliveredAt: feedbackNow });
  const topicAt = (number: number) => topics.listCurrentTopics().find((t) => t.id === map.itemRefs.find((r) => r.displayedNumber === number)!.id)!;
  const runtime = createFounderStreamRuntime({ client: db.client, jobRepository: new JobRepository(db.client),
    flags: { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false, manualQueryEnabled: true },
    approvedChatIds: [chatId], ivyPrivateChatId: 'oc_private', now: () => feedbackNow,
    analyzer: { async analyze() { return { topics: [] }; } } });
  return { db, topicAt, runtime };
}

function groupEvent(messageId: string, text: string, parentId = '') {
  return { header: { event_id: `evt_${messageId}`, create_time: String(feedbackNow.getTime()) }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_ivy' } }, message: { message_id: messageId, chat_id: chatId,
      chat_type: 'group', message_type: 'text', parent_id: parentId, root_id: parentId,
      content: JSON.stringify({ text }), create_time: String(feedbackNow.getTime()) } } };
}

describe('founder messages that mention the bot', () => {
  it('routes a mentioned confirmation and a mentioned 确认 reply to the draft message as feedback', () => {
    for (const style of ['confirmation', 'reply'] as const) {
      const h = harness(), runtime = h.runtime;
      const drafted = runtime.route.ingest(groupEvent('om_batch', '@_user_1 #2 暂停，等待 Jimmy 反馈\n#3 第一期已发布', 'om_map'));
      expect(drafted).toMatchObject({ status: 'founder_feedback_decision', decision: { kind: 'drafted' } });
      const draftId = (drafted as { decision: { draftId: string } }).decision.draftId;
      // The draft reply goes out through the outbox; simulate its delivery so a reply to it can be resolved.
      h.db.client.prepare("UPDATE outbox SET status='delivered',delivered_at=?,delivered_message_id='om_draft_reply' WHERE json_extract(payload,'$.kind')='founder_feedback'")
        .run(feedbackNow.toISOString());
      const confirm = style === 'confirmation'
        ? groupEvent('om_confirm', `@_user_1 确认修正 ${draftId}`)
        : groupEvent('om_confirm', '@_user_1 确认', 'om_draft_reply');
      expect(runtime.route.ingest(confirm)).toMatchObject({ status: 'founder_feedback_decision',
        decision: { kind: 'corrected', correctionKind: 'batch_correction', status: 'applied' } });
      expect(h.topicAt(2).stage).toBe('paused');
      h.db.client.close();
    }
  });

  it('routes a mentioned single-item reply to the work map', () => {
    const h = harness(), runtime = h.runtime;
    expect(runtime.route.ingest(groupEvent('om_single', '@_user_1 第4项改为已结束', 'om_map')))
      .toMatchObject({ status: 'founder_feedback_decision', decision: { kind: 'corrected' } });
    expect(h.topicAt(4).stage).toBe('closed');
    h.db.client.close();
  });
});
