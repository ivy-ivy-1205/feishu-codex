import { createSqliteDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { AlignmentRepository } from '../../src/repositories/alignment-repository.js';
import { TopicRepository } from '../../src/repositories/topic-repository.js';
import { OutboxRepository } from '../../src/repositories/outbox-repository.js';
import { renderFounderWorkMap } from '../../src/services/founder-work-map-renderer.js';

export const feedbackNow = new Date('2026-09-21T10:00:00.000Z');
export const feedbackChat = 'oc_founders_fixture';
export function feedbackHarness(count = 4, delivered = true) {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const alignment = new AlignmentRepository(db.client);
  for (const founder of ['ivy', 'james'] as const) alignment.configureFounderIdentity({ founder,
    sourceSystem: 'feishu', externalAuthorId: `ou_${founder}`, configuredAt: feedbackNow });
  const topics = new TopicRepository(db.client);
  const created = Array.from({ length: count }, (_, i) => topics.createTopic({ displayName: `话题${i}`,
    stage: 'active_project', createdAt: feedbackNow }));
  const map = renderFounderWorkMap({ since: '2026-09-01T10:00:00.000Z', until: feedbackNow.toISOString(),
    topics: created.map((t) => ({ ...t, evidence: [] })), uncertainGrouping: [], coverageGaps: [] })[0]!;
  const outbox = new OutboxRepository(db.client);
  outbox.enqueueFounderWorkMap({ ...map, mapId: 'map_fixture', targetChatId: feedbackChat }, feedbackNow);
  if (delivered) outbox.acknowledgeFounderWorkMapDelivery({ mapId: 'map_fixture', page: 1,
    messageId: 'om_map', deliveredAt: feedbackNow });
  const topicAt = (number: number) => topics.listCurrentTopics().find((t) => t.id === map.itemRefs.find((r) => r.displayedNumber === number)!.id)!;
  return { db, alignment, topics, created, map, outbox, topicAt,
    dependencies: { client: db.client, approvedChatIds: [feedbackChat], now: () => feedbackNow },
    input: { chatId: feedbackChat, openId: 'ou_ivy', messageId: 'om_feedback', replyTo: 'om_map',
      text: '2 和 4 是同一个项目', occurredAt: feedbackNow.toISOString() } };
}
