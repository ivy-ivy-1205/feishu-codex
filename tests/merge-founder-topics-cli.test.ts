import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import { runMergeFounderTopicsCli } from '../src/cli/merge-founder-topics.js';

function setup(duplicateFirst = false, registerShown = false) {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const topics = new TopicRepository(db.client);
  const create = (displayName: string, at: string) => topics.createTopic({ displayName, stage: 'active_project', outcome: null, createdAt: new Date(at) });
  const [first, second] = duplicateFirst ? ['56 Bonnefin这个项目', '56 Bonnefin 楼花展示项目总览'] : ['56 Bonnefin 楼花展示项目总览', '56 Bonnefin这个项目'];
  const a = create(first, '2026-10-20T00:00:00.000Z'), b = create(second, '2026-10-21T00:00:00.000Z');
  const shown = duplicateFirst ? b : a, duplicate = duplicateFirst ? a : b;
  if (registerShown) {
    db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
      VALUES ('bonnefin-56', '56 Bonnefin 楼花展示', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run('2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
    new FounderTopicProjectBindingRepository(db.client).recordHumanConfirmed({ topicId: shown.id, projectKey: 'bonnefin-56', role: 'canonical',
      at: new Date('2026-10-27T00:00:00.000Z') });
  }
  const out: string[] = [];
  const run = (...args: string[]) => runMergeFounderTopicsCli(args, { client: db.client, now: () => new Date('2026-10-30T08:00:00.000Z'),
    write: (line) => out.push(line) });
  return { db, topics, shown, duplicate, out, run };
}

describe('merge-founder-topics CLI', () => {
  it('previews by default, then merges the hidden duplicate into the shown item and keeps the shown item canonical', () => {
    const h = setup();
    expect(h.run('--into', h.shown.id, '--from', h.duplicate.id)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ mode: 'preview', status: 'ready', into: { name: '56 Bonnefin 楼花展示项目总览' } });
    expect(h.topics.listRelations()).toEqual([]);
    expect(() => h.run('--into', h.shown.id, '--from', h.duplicate.id, '--apply')).toThrow('MERGE_TOPICS_ARGUMENTS_INVALID');
    expect(h.run('--into', h.shown.id, '--from', h.duplicate.id, '--apply', '--change-ref', 'merge-bonnefin')).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ mode: 'applied', status: 'merged' });
    expect(h.topics.listCanonicalTopics().map((topic) => topic.id)).toEqual([h.shown.id]);
    expect(h.topics.listRelations()).toMatchObject([{ relationType: 'same_as', rationale: 'Ivy 确认属于同一项目（merge-bonnefin）' }]);
    expect(h.topics.listCurrentTopics()).toHaveLength(2);
    expect(h.run('--into', h.shown.id, '--from', h.duplicate.id)).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ status: 'already_merged' });
  });

  it('merges an older duplicate when the shown item carries the registered Space page, which keeps it shown (56 Bonnefin)', () => {
    const h = setup(true, true);
    expect(h.run('--into', h.shown.id, '--from', h.duplicate.id)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ mode: 'preview', status: 'ready' });
    expect(h.topics.listRelations()).toEqual([]);
    expect(h.run('--into', h.shown.id, '--from', h.duplicate.id, '--apply', '--change-ref', 'merge-bonnefin')).toBe(0);
    expect(h.topics.listCanonicalTopics().map((topic) => topic.id)).toEqual([h.shown.id]);
    expect(h.topics.listCanonicalTopics()[0]!.displayName).toBe('56 Bonnefin 楼花展示项目总览');
  });

  it('refuses when the duplicate is older and nothing registered keeps the shown item, because the merge would replace it', () => {
    const h = setup(true);
    expect(h.run('--into', h.shown.id, '--from', h.duplicate.id, '--apply', '--change-ref', 'merge-bonnefin')).toBe(2);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ mode: 'rejected', status: 'would_replace_shown_topic' });
    expect(h.topics.listRelations()).toEqual([]);
  });
});
