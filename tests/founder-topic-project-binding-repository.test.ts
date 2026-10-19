import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';

function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  database.client.prepare(`
    INSERT INTO context_topics (id, current_version, created_at, updated_at)
    VALUES ('topic-1', 1, ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  return new FounderTopicProjectBindingRepository(database.client);
}

describe('FounderTopicProjectBindingRepository', () => {
  it('records a human-confirmed canonical binding and reads it back by project', () => {
    const repository = setup();
    const binding = repository.recordHumanConfirmed({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T00:00:00.000Z')
    });
    expect(binding.source).toBe('human_confirmed');
    expect(repository.getCanonicalBindingForProject('smart_listing')?.topicId).toBe('topic-1');
  });

  it('lets an analysis proposal apply when no binding exists yet', () => {
    const repository = setup();
    const result = repository.proposeFromAnalysis({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T00:00:00.000Z')
    });
    expect(result.applied).toBe(true);
    expect(result.binding.source).toBe('analysis');
  });

  it('never lets an analysis proposal override an existing human-confirmed binding', () => {
    const repository = setup();
    repository.recordHumanConfirmed({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T00:00:00.000Z')
    });
    const result = repository.proposeFromAnalysis({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T01:00:00.000Z')
    });
    expect(result.applied).toBe(false);
    expect(result.binding.source).toBe('human_confirmed');
    expect(repository.getCanonicalBindingForProject('smart_listing')?.source).toBe('human_confirmed');
  });

  it('lets a human correction overwrite a prior analysis-sourced binding for the same triple', () => {
    const repository = setup();
    repository.proposeFromAnalysis({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T00:00:00.000Z')
    });
    const confirmed = repository.recordHumanConfirmed({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T01:00:00.000Z')
    });
    expect(confirmed.source).toBe('human_confirmed');
  });

  it('lists all bindings for a topic across roles', () => {
    const repository = setup();
    repository.recordHumanConfirmed({
      topicId: 'topic-1', projectKey: 'smart_listing', role: 'canonical', at: new Date('2026-10-19T00:00:00.000Z')
    });
    expect(repository.listForTopic('topic-1')).toHaveLength(1);
    expect(repository.listForProject('smart_listing')).toHaveLength(1);
  });
});
