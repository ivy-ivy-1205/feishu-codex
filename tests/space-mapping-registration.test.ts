import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { applySpaceMapping, previewSpaceMapping, SpaceMappingRejectedError } from '../src/services/space-mapping-registration.js';
import { runRegisterSpaceMappingCli } from '../src/cli/register-space-mapping.js';
import { buildFounderManualQueryMessages } from '../src/services/founder-manual-query.js';

const at = new Date('2026-10-19T08:00:00.000Z');
const chatId = 'oc_a84d5b6ca478220d0a37964b50776edb';
const planText = readFileSync(new URL('../docs/2026-10-19-space-mapping-plan.json', import.meta.url), 'utf8');
const plan = () => JSON.parse(planText) as { projects: Record<string, unknown>[]; authors: Record<string, unknown>[] };

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const topics = new TopicRepository(db.client);
  const a = topics.createTopic({ displayName: 'AiJia AI Native 房产业务', stage: 'active_project', createdAt: at });
  const b = topics.createTopic({ displayName: '自媒体生产线', stage: 'active_project', createdAt: at });
  const smart = topics.createTopic({ displayName: 'Smart Listing', stage: 'active_project', outcome: '27 Cecil Street', createdAt: at });
  topics.addRelation({ fromTopicId: smart.id, toTopicId: a.id, relationType: 'part_of', rationale: 'baseline', createdAt: at });
  return { db, topics, a, b, smart };
}
const counts = (db: ReturnType<typeof setup>['db']) => Object.fromEntries(['projects', 'project_space_bindings',
  'founder_topic_project_bindings', 'context_topics', 'founder_identities'].map((table) =>
  [table, (db.client.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));

describe('Space mapping registration', () => {
  it('previews the confirmed three-project plan without writing anything', () => {
    const h = setup();
    const before = counts(h.db);
    const preview = previewSpaceMapping(h.db.client, plan());
    expect(preview.ok).toBe(true);
    expect(preview.actions.filter((a) => a.step === 'topic').map((a) => a.detail)).toEqual([
      `使用工作地图条目：Smart Listing（${h.smart.id}）`,
      '在 A 线下新建条目：Family First（active_project）',
      '在 B 线下新建条目：超级个体到超级团队（active_project）']);
    expect(counts(h.db)).toEqual(before);
  });

  it('applies: registers projects, page bindings, human-confirmed topic bindings and line placement', () => {
    const h = setup();
    applySpaceMapping(h.db.client, plan(), { changeReference: 'CHG-SPACE-MAP-1', at });
    const bindings = new FounderTopicProjectBindingRepository(h.db.client), spaceSync = new SpaceSyncRepository(h.db.client);
    expect(bindings.getCanonicalBindingForProject('smart-listing')).toMatchObject({ topicId: h.smart.id, source: 'human_confirmed' });
    expect(spaceSync.getBindingByPageId('page_99af645338808191b63c00a4ba33b031')).toMatchObject({ projectKey: 'super-individual-to-team', status: 'active' });
    const super_ = h.topics.listCurrentTopics().find((t) => t.displayName === '超级个体到超级团队')!;
    expect(h.topics.listRelations(super_.id)).toEqual(expect.arrayContaining([expect.objectContaining({
      fromTopicId: super_.id, toTopicId: h.b.id, relationType: 'part_of' })]));
    expect(h.db.client.prepare("SELECT origin FROM projects WHERE project_key='family-first-ai-os'").get()).toEqual({ origin: 'human_confirmed' });
    // Lands in the right A/B sections of the work map.
    const map = JSON.stringify(buildFounderManualQueryMessages({ client: h.db.client, query: { kind: 'work_map' },
      queryMessageId: 'om_map', chatId, approvedChatIds: [chatId], now: at }).map((m) => m.card));
    expect(map).toMatch(/A 线｜AiJia AI Native 房产业务[\s\S]*Family First[\s\S]*B 线｜自媒体生产线[\s\S]*超级个体到超级团队/u);
    // Re-applying is a no-op.
    const before = counts(h.db);
    expect(previewSpaceMapping(h.db.client, plan()).actions.every((a) => a.status === 'unchanged')).toBe(true);
    expect(counts(h.db)).toEqual(before);
  });

  it('rejects the whole plan, writing nothing, when any target conflicts', () => {
    const h = setup();
    h.db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
      VALUES ('smart-listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(at.toISOString(), at.toISOString());
    new SpaceSyncRepository(h.db.client).createBinding({ id: 'x', projectKey: 'smart-listing', spaceId: null, pageId: 'page_other',
      pageUrl: 'https://chatgpt.com/space/page_other', managementMode: 'space', syncMode: 'manual', createdAt: at });
    const before = counts(h.db);
    expect(previewSpaceMapping(h.db.client, plan()).actions.find((a) => a.step === 'page_binding')).toMatchObject({ status: 'conflict' });
    expect(() => applySpaceMapping(h.db.client, plan(), { changeReference: 'CHG', at })).toThrow(SpaceMappingRejectedError);
    expect(counts(h.db)).toEqual(before);
  });

  it('rejects ambiguous or missing topic names and line roots', () => {
    const h = setup();
    h.topics.createTopic({ displayName: 'Smart Listing', stage: 'idea', createdAt: new Date(at.getTime() + 1) });
    h.db.client.prepare("UPDATE context_topic_versions SET display_name='旧名' WHERE display_name='自媒体生产线'").run();
    const before = counts(h.db);
    const preview = previewSpaceMapping(h.db.client, plan());
    expect(preview.ok).toBe(false);
    expect(preview.actions.filter((a) => a.step === 'topic').map((a) => a.status)).toEqual(['ambiguous', 'will_create', 'not_found']);
    expect(() => applySpaceMapping(h.db.client, plan(), { changeReference: 'CHG', at })).toThrow(SpaceMappingRejectedError);
    expect(counts(h.db)).toEqual(before);
  });

  it('never rewrites an existing Space author identity and requires a change reference', () => {
    const h = setup();
    const withAuthors = { ...plan(), authors: [{ founder: 'ivy', spaceAuthorId: 'space_user_1' }] };
    applySpaceMapping(h.db.client, withAuthors, { changeReference: 'CHG-1', at });
    const swapped = { ...plan(), authors: [{ founder: 'james', spaceAuthorId: 'space_user_1' }] };
    expect(previewSpaceMapping(h.db.client, swapped).actions.find((a) => a.step === 'author')).toMatchObject({ status: 'conflict' });
    expect(() => applySpaceMapping(h.db.client, plan(), { changeReference: '  ', at })).toThrow('SPACE_MAPPING_CHANGE_REFERENCE_REQUIRED');
  });

  it('CLI previews by default and only writes with --apply', () => {
    const h = setup();
    const out: string[] = [];
    const deps = { readFile: () => planText, client: h.db.client, now: () => at, write: (line: string) => out.push(line) };
    expect(runRegisterSpaceMappingCli(['--plan', 'plan.json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ mode: 'preview', ok: true });
    expect(new FounderTopicProjectBindingRepository(h.db.client).getCanonicalBindingForProject('smart-listing')).toBeNull();
    expect(runRegisterSpaceMappingCli(['--plan', 'plan.json', '--apply', '--change-ref', 'CHG-1'], deps)).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ mode: 'applied' });
    expect(new FounderTopicProjectBindingRepository(h.db.client).getCanonicalBindingForProject('smart-listing')).not.toBeNull();
  });
});
