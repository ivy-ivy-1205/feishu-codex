import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import {
  migrateSpaceManagedVisibilityToVisible, reviewSpaceManagedVisibility
} from '../src/services/space-managed-visibility-migration.js';

const at = new Date('2026-10-19T00:00:00.000Z');

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`)
    .run(at.toISOString(), at.toISOString());
  const topics = new TopicRepository(db.client);
  const topic = topics.createTopic({ displayName: 'Smart Listing', stage: 'active_project', createdAt: at });
  db.client.prepare(`INSERT INTO founder_topic_visibility (topic_id, visibility, source_message_id, updated_at)
    VALUES (?, 'space_managed', 'legacy_hide_message', ?)`).run(topic.id, at.toISOString());
  return { db, topic, spaceSync: new SpaceSyncRepository(db.client), bindings: new FounderTopicProjectBindingRepository(db.client) };
}

function visibilityRow(db: ReturnType<typeof setup>['db'], topicId: string) {
  return db.client.prepare('SELECT visibility, source_message_id, updated_at FROM founder_topic_visibility WHERE topic_id = ?')
    .get(topicId) as { visibility: string; source_message_id: string; updated_at: string } | undefined;
}

describe('space-managed visibility migration capability (not a production migration)', () => {
  it('rejects when the topic is not currently space_managed', () => {
    const h = setup();
    h.db.client.prepare("UPDATE founder_topic_visibility SET visibility='visible' WHERE topic_id=?").run(h.topic.id);
    const result = migrateSpaceManagedVisibilityToVisible({ client: h.db.client, topicId: h.topic.id,
      projectKey: 'smart_listing', changeReference: 'CHG-1', at });
    expect(result).toEqual({ status: 'rejected', reason: 'not_space_managed' });
  });

  it('rejects when there is no canonical project binding for this topic', () => {
    const h = setup();
    const result = migrateSpaceManagedVisibilityToVisible({ client: h.db.client, topicId: h.topic.id,
      projectKey: 'smart_listing', changeReference: 'CHG-1', at });
    expect(result).toEqual({ status: 'rejected', reason: 'no_canonical_binding' });
    expect(visibilityRow(h.db, h.topic.id)).toMatchObject({ visibility: 'space_managed' });
  });

  it('rejects when the canonical binding points to a different topic', () => {
    const h = setup();
    const other = new TopicRepository(h.db.client).createTopic({ displayName: 'Other', stage: 'idea', createdAt: at });
    h.bindings.recordHumanConfirmed({ topicId: other.id, projectKey: 'smart_listing', role: 'canonical', at });
    const result = migrateSpaceManagedVisibilityToVisible({ client: h.db.client, topicId: h.topic.id,
      projectKey: 'smart_listing', changeReference: 'CHG-1', at });
    expect(result).toEqual({ status: 'rejected', reason: 'no_canonical_binding' });
  });

  it('rejects when the project_space_bindings record is not active', () => {
    const h = setup();
    h.bindings.recordHumanConfirmed({ topicId: h.topic.id, projectKey: 'smart_listing', role: 'canonical', at });
    const binding = h.spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
      pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: at });
    h.spaceSync.recordSyncFailure({ bindingId: binding.id, errorCode: 'permission_denied', attemptedAt: at });
    const result = migrateSpaceManagedVisibilityToVisible({ client: h.db.client, topicId: h.topic.id,
      projectKey: 'smart_listing', changeReference: 'CHG-1', at });
    expect(result).toEqual({ status: 'rejected', reason: 'binding_not_active' });
    expect(visibilityRow(h.db, h.topic.id)).toMatchObject({ visibility: 'space_managed' });
  });

  it('applies the flip to visible only when all three preconditions hold, recording the change reference', () => {
    const h = setup();
    h.bindings.recordHumanConfirmed({ topicId: h.topic.id, projectKey: 'smart_listing', role: 'canonical', at });
    h.spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
      pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: at });
    const result = migrateSpaceManagedVisibilityToVisible({ client: h.db.client, topicId: h.topic.id,
      projectKey: 'smart_listing', changeReference: 'CHG-42', at: new Date(at.getTime() + 1_000) });
    expect(result).toEqual({ status: 'applied' });
    expect(visibilityRow(h.db, h.topic.id)).toEqual({ visibility: 'visible', source_message_id: 'CHG-42',
      updated_at: new Date(at.getTime() + 1_000).toISOString() });
  });

  it('throws on a blank change reference rather than silently proceeding', () => {
    const h = setup();
    h.bindings.recordHumanConfirmed({ topicId: h.topic.id, projectKey: 'smart_listing', role: 'canonical', at });
    h.spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
      pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: at });
    expect(() => migrateSpaceManagedVisibilityToVisible({ client: h.db.client, topicId: h.topic.id,
      projectKey: 'smart_listing', changeReference: '  ', at })).toThrow();
    expect(visibilityRow(h.db, h.topic.id)).toMatchObject({ visibility: 'space_managed' });
  });

  it('review is read-only and matches what migrate would decide, without ever writing', () => {
    const h = setup();
    const before = reviewSpaceManagedVisibility({ client: h.db.client, topicId: h.topic.id, projectKey: 'smart_listing' });
    expect(before).toEqual({ eligible: false, reason: 'no_canonical_binding' });
    expect(visibilityRow(h.db, h.topic.id)).toMatchObject({ visibility: 'space_managed' });

    h.bindings.recordHumanConfirmed({ topicId: h.topic.id, projectKey: 'smart_listing', role: 'canonical', at });
    h.spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
      pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: at });
    const after = reviewSpaceManagedVisibility({ client: h.db.client, topicId: h.topic.id, projectKey: 'smart_listing' });
    expect(after).toEqual({ eligible: true });
    expect(visibilityRow(h.db, h.topic.id)).toMatchObject({ visibility: 'space_managed' });
  });

  it('does not auto-flip visibility just because management_mode/binding state changes — the two tables stay decoupled', () => {
    const h = setup();
    h.bindings.recordHumanConfirmed({ topicId: h.topic.id, projectKey: 'smart_listing', role: 'canonical', at });
    h.spaceSync.createBinding({ id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
      pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual', createdAt: at });
    // Creating the binding (and it being active) must never itself touch founder_topic_visibility.
    expect(visibilityRow(h.db, h.topic.id)).toMatchObject({ visibility: 'space_managed' });
  });
});
