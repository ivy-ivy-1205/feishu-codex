import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';

function seedProject(client: ReturnType<typeof createSqliteDatabase>['client'], projectKey: string): void {
  client.prepare(`
    INSERT INTO projects (
      project_key, display_name, aliases, status, origin, stage, created_at, updated_at
    ) VALUES (?, ?, '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run(projectKey, projectKey, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
}

function seedTopic(client: ReturnType<typeof createSqliteDatabase>['client'], topicId: string): void {
  client.prepare(`
    INSERT INTO context_topics (id, current_version, created_at, updated_at)
    VALUES (?, 1, ?, ?)
  `).run(topicId, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
}

describe('space sync migration', () => {
  it('creates project_space_bindings, founder_topic_project_bindings and space_sync_runs', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);

    const tables = database.client.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
        ('project_space_bindings', 'founder_topic_project_bindings', 'space_sync_runs')
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(['founder_topic_project_bindings', 'project_space_bindings', 'space_sync_runs']);
  });

  it('is repeatable (idempotent re-run leaves existing rows untouched)', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    seedProject(database.client, 'smart_listing');
    database.client.prepare(`
      INSERT INTO project_space_bindings (
        id, project_key, provider, space_id, page_id, page_url, management_mode,
        sync_mode, status, created_at, updated_at
      ) VALUES ('binding-1', 'smart_listing', 'chatgpt_space', NULL, 'page_1',
        'https://chatgpt.com/space/page_1', 'space', 'manual', 'active', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');

    expect(() => migrateDatabase(database.client)).not.toThrow();

    expect(database.client.prepare(`
      SELECT status FROM project_space_bindings WHERE id = 'binding-1'
    `).get()).toEqual({ status: 'active' });
  });

  it('enforces a unique page_id across bindings', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    seedProject(database.client, 'smart_listing');
    seedProject(database.client, 'other_project');
    database.client.prepare(`
      INSERT INTO project_space_bindings (
        id, project_key, provider, space_id, page_id, page_url, management_mode,
        sync_mode, status, created_at, updated_at
      ) VALUES ('binding-1', 'smart_listing', 'chatgpt_space', NULL, 'page_1',
        'https://chatgpt.com/space/page_1', 'space', 'manual', 'active', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');

    expect(() => database.client.prepare(`
      INSERT INTO project_space_bindings (
        id, project_key, provider, space_id, page_id, page_url, management_mode,
        sync_mode, status, created_at, updated_at
      ) VALUES ('binding-2', 'other_project', 'chatgpt_space', NULL, 'page_1',
        'https://chatgpt.com/space/page_1', 'space', 'manual', 'active', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')).toThrow(/UNIQUE/);
  });

  it('rejects an unknown management_mode', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    seedProject(database.client, 'smart_listing');

    expect(() => database.client.prepare(`
      INSERT INTO project_space_bindings (
        id, project_key, provider, space_id, page_id, page_url, management_mode,
        sync_mode, status, created_at, updated_at
      ) VALUES ('binding-1', 'smart_listing', 'chatgpt_space', NULL, 'page_1',
        'https://chatgpt.com/space/page_1', 'bogus', 'manual', 'active', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')).toThrow(/CHECK/);
  });

  it('allows at most one role per (topic, project) pair in founder_topic_project_bindings', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    seedProject(database.client, 'smart_listing');
    seedTopic(database.client, 'topic-1');
    database.client.prepare(`
      INSERT INTO founder_topic_project_bindings (topic_id, project_key, role, source, created_at, updated_at)
      VALUES ('topic-1', 'smart_listing', 'canonical', 'human_confirmed', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');

    expect(() => database.client.prepare(`
      INSERT INTO founder_topic_project_bindings (topic_id, project_key, role, source, created_at, updated_at)
      VALUES ('topic-1', 'smart_listing', 'canonical', 'analysis', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('requires a page_source_created boolean flag and rejects a non-boolean value', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    seedProject(database.client, 'smart_listing');
    database.client.prepare(`
      INSERT INTO project_space_bindings (
        id, project_key, provider, space_id, page_id, page_url, management_mode,
        sync_mode, status, created_at, updated_at
      ) VALUES ('binding-1', 'smart_listing', 'chatgpt_space', NULL, 'page_1',
        'https://chatgpt.com/space/page_1', 'space', 'manual', 'active', ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');

    expect(() => database.client.prepare(`
      INSERT INTO space_sync_runs (
        id, binding_id, project_key, page_id, trigger, envelope_hash,
        page_source_created, coverage_page_complete, coverage_comments_complete,
        started_at, completed_at
      ) VALUES ('run-1', 'binding-1', 'smart_listing', 'page_1', 'manual', 'hash-1',
        2, 1, 1, ?, ?)
    `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')).toThrow(/CHECK/);
  });
});
