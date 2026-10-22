import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { SpaceProjectDigestRepository } from '../src/repositories/space-project-digest-repository.js';
import {
  buildSpaceDigestInput, SpaceDigestValidationError, validateSpaceDigest, type SpaceProjectDigestInput
} from '../src/services/space-project-digest.js';
import { CodexSpaceProjectDigestAnalyzer } from '../src/adapters/codex-space-project-digest.js';

const at = new Date('2026-10-21T02:00:00.000Z');
const block = (id: string, hashChar: string, markdown: string) => ({ id, hash: hashChar.repeat(64), markdown });

function setup() {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart-listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(at.toISOString(), at.toISOString());
  return { db, sources: new ContextSourceRepository(db.client), digests: new SpaceProjectDigestRepository(db.client) };
}

function savePage(sources: ContextSourceRepository, occurredAt: string, blocks: ReturnType<typeof block>[]) {
  return sources.saveSource({ sourceSystem: 'chatgpt_space', sourceType: 'space_page_snapshot', externalId: 'page_1',
    logicalKey: 'chatgpt_space:page:page_1', occurredAt, authors: [], locatorUri: 'https://chatgpt.com/space/page_1',
    contentFormat: 'text/markdown', contentText: blocks.map((b) => b.markdown).join('\n\n'),
    metadata: { pageId: 'page_1', title: 'AiJia Smart Listing 与买家空间项目总览', blocks }, availabilityStatus: 'available', capturedAt: at }).source;
}

function weekInput(): SpaceProjectDigestInput {
  return { projectKey: 'smart-listing', projectName: 'Smart Listing', pageTitle: 'P', pageUpdatedAt: at.toISOString(),
    changeBasis: 'version_diff', truncated: false, blocks: [
      { id: 'b_old', markdown: '项目目标：上线买家空间', changedThisWeek: false, changedToday: false },
      { id: 'b_week', markdown: '27 Cecil Street 页面已上线，等待 Amy 反馈', changedThisWeek: true, changedToday: false },
      { id: 'b_today', markdown: '今天补齐了户型图与周边配套', changedThisWeek: true, changedToday: true }
    ] };
}

const item = (blockId: string, excerpt: string) => ({ text: excerpt.slice(0, 20), blockId, excerpt });
const noProfile = { positioning: null, phases: [], completed: [], inProgress: [], pending: [], problems: [], divergences: [], nextPlan: [] };

describe('buildSpaceDigestInput', () => {
  it('marks this-week and today changed blocks from stored page versions', () => {
    const h = setup();
    savePage(h.sources, '2026-10-14T02:00:00.000Z', [block('b1', 'a', '目标'), block('b2', 'b', '旧进展')]);
    savePage(h.sources, '2026-10-20T02:00:00.000Z', [block('b1', 'a', '目标'), block('b2', 'c', '新进展')]);
    const latest = savePage(h.sources, '2026-10-21T01:00:00.000Z', [block('b1', 'a', '目标'), block('b2', 'c', '新进展'), block('b3', 'd', '今天')]);
    const input = buildSpaceDigestInput({ projectKey: 'smart-listing', projectName: 'Smart Listing', page: latest,
      versions: h.sources.listSources().filter((s) => s.sourceType === 'space_page_snapshot'), now: at });
    expect(input).toMatchObject({ changeBasis: 'version_diff', pageTitle: 'AiJia Smart Listing 与买家空间项目总览', truncated: false });
    expect(input.blocks.map((b) => [b.id, b.changedThisWeek, b.changedToday])).toEqual([
      ['b1', false, false], ['b2', true, false], ['b3', true, true]]);
  });

  it('ignores page versions newer than the one being digested', () => {
    const h = setup();
    const older = savePage(h.sources, '2026-10-14T02:00:00.000Z', [block('b1', 'a', '目标')]);
    savePage(h.sources, '2026-10-21T01:00:00.000Z', [block('b1', 'z', '改了')]);
    const input = buildSpaceDigestInput({ projectKey: 'smart-listing', projectName: 'Smart Listing', page: older,
      versions: h.sources.listSources(), now: at });
    expect(input.blocks).toEqual([{ id: 'b1', markdown: '目标', changedThisWeek: false, changedToday: false }]);
  });
});

describe('validateSpaceDigest', () => {
  it('accepts a grounded, capped digest', () => {
    const digest = { currentFocus: item('b_old', '上线买家空间'), weekProgress: [item('b_week', '27 Cecil Street 页面已上线')],
      todayProgress: [item('b_today', '补齐了户型图')], nextSteps: [{ ...item('b_week', '等待 Amy 反馈'), kind: 'blocker' }], profile: noProfile };
    expect(validateSpaceDigest(digest, weekInput())).toEqual(digest);
  });

  it.each([
    ['unknown_block', { currentFocus: item('b_missing', '上线'), weekProgress: [], todayProgress: [], nextSteps: [], profile: noProfile }],
    ['excerpt_not_verbatim', { currentFocus: item('b_old', '上线卖家空间'), weekProgress: [], todayProgress: [], nextSteps: [], profile: noProfile }],
    ['week_item_not_changed_this_week', { currentFocus: null, weekProgress: [item('b_old', '上线买家空间')], todayProgress: [], nextSteps: [], profile: noProfile }],
    ['today_item_not_changed_today', { currentFocus: null, weekProgress: [], todayProgress: [item('b_week', '页面已上线')], nextSteps: [], profile: noProfile }],
    ['schema_invalid', { currentFocus: null, weekProgress: [1, 2, 3, 4].map(() => item('b_week', '页面已上线')), todayProgress: [], nextSteps: [], profile: noProfile }]
  ])('rejects %s', (reason, digest) => {
    expect(() => validateSpaceDigest(digest, weekInput())).toThrow(expect.objectContaining({ reason }));
  });

  it('accepts a grounded project profile: positioning, phases, and each progress section', () => {
    const profile = { positioning: item('b_old', '上线买家空间'),
      phases: [{ ...item('b_old', '项目目标'), name: '第一阶段', status: 'done' }, { ...item('b_week', '27 Cecil Street 页面已上线'), name: '样板上线', status: 'current' }],
      completed: [item('b_week', '27 Cecil Street 页面已上线')], inProgress: [item('b_today', '补齐了户型图')], pending: [],
      problems: [item('b_week', '等待 Amy 反馈')], divergences: [], nextPlan: [item('b_week', '等待 Amy 反馈')] };
    const digest = { currentFocus: null, weekProgress: [], todayProgress: [], nextSteps: [], profile };
    expect(validateSpaceDigest(digest, weekInput())).toEqual(digest);
  });

  it.each([
    ['schema_invalid', undefined],
    ['unknown_block', { ...noProfile, completed: [item('b_missing', '上线')] }],
    ['excerpt_not_verbatim', { ...noProfile, positioning: item('b_old', '上线卖家空间') }],
    ['phase_current_not_unique', { ...noProfile, phases: [{ ...item('b_old', '项目目标'), name: '一', status: 'current' },
      { ...item('b_week', '页面已上线'), name: '二', status: 'current' }] }]
  ])('rejects a profile with %s', (reason, profile) => {
    const digest = { currentFocus: null, weekProgress: [], todayProgress: [], nextSteps: [], ...(profile ? { profile } : {}) };
    expect(() => validateSpaceDigest(digest, weekInput())).toThrow(expect.objectContaining({ reason }));
  });

  it('allows page-recorded progress but no "today" claims on a first snapshot', () => {
    const input = { ...weekInput(), changeBasis: 'first_snapshot' as const };
    expect(validateSpaceDigest({ currentFocus: null, weekProgress: [item('b_old', '上线买家空间')], todayProgress: [], nextSteps: [], profile: noProfile }, input))
      .toMatchObject({ weekProgress: [{ blockId: 'b_old' }] });
    expect(() => validateSpaceDigest({ currentFocus: null, weekProgress: [], todayProgress: [item('b_today', '补齐了户型图')], nextSteps: [], profile: noProfile }, input))
      .toThrow(SpaceDigestValidationError);
  });
});

describe('CodexSpaceProjectDigestAnalyzer', () => {
  it('retries once with the validation reason, then returns the grounded digest', async () => {
    const prompts: string[] = [];
    const outputs = [
      { currentFocus: item('b_old', '编造的原文'), weekProgress: [], todayProgress: [], nextSteps: [], profile: noProfile },
      { currentFocus: item('b_old', '上线买家空间'), weekProgress: [], todayProgress: [], nextSteps: [], profile: noProfile }
    ];
    const analyzer = new CodexSpaceProjectDigestAnalyzer({ codex: { async executeJson({ prompt }) { prompts.push(prompt); return outputs.shift(); } } });
    await expect(analyzer.digest(weekInput())).resolves.toMatchObject({ currentFocus: { blockId: 'b_old' } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('excerpt_not_verbatim');
    expect(prompts[0]).toContain('项目页记载');
    expect(prompts[0]).toContain('profile.phases');
    expect(prompts[0]).toContain('不要自行划分');
    expect(prompts[0]).toContain('「阶段规划」');
  });

  it('fails after two invalid outputs instead of storing an ungrounded digest', async () => {
    const analyzer = new CodexSpaceProjectDigestAnalyzer({ codex: { async executeJson() {
      return { currentFocus: item('b_missing', 'x'), weekProgress: [], todayProgress: [], nextSteps: [], profile: noProfile }; } } });
    await expect(analyzer.digest(weekInput())).rejects.toBeInstanceOf(SpaceDigestValidationError);
  });
});

describe('SpaceProjectDigestRepository', () => {
  it('stores one digest per page version and never lets a failure overwrite a ready digest', () => {
    const h = setup();
    const page = savePage(h.sources, '2026-10-21T01:00:00.000Z', [block('b1', 'a', '目标')]);
    const base = { projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: page.id, pageSourceVersion: page.sourceVersion,
      pageUpdatedAt: page.occurredAt, generatedAt: at };
    h.digests.saveFailed({ ...base, failureCode: 'SPACE_DIGEST_OUTPUT_INVALID' });
    expect(h.digests.getLatestForProject('smart-listing')).toMatchObject({ status: 'failed', failureCode: 'SPACE_DIGEST_OUTPUT_INVALID' });
    const digest = { currentFocus: { text: '目标', blockId: 'b1', excerpt: '目标' }, weekProgress: [], todayProgress: [], nextSteps: [], profile: noProfile };
    h.digests.saveReady({ ...base, changeBasis: 'first_snapshot', digest });
    h.digests.saveFailed({ ...base, failureCode: 'LATER_FAILURE' });
    expect(h.digests.getForPageSource(page.id)).toMatchObject({ status: 'ready', digest, failureCode: null });
  });

  it('still reads a digest stored before profiles existed, and lets a profiled digest replace it', () => {
    const h = setup();
    const page = savePage(h.sources, '2026-10-21T01:00:00.000Z', [block('b1', 'a', '目标')]);
    const base = { projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: page.id, pageSourceVersion: page.sourceVersion,
      pageUpdatedAt: page.occurredAt, generatedAt: at };
    const legacy = { currentFocus: { text: '目标', blockId: 'b1', excerpt: '目标' }, weekProgress: [], todayProgress: [], nextSteps: [] };
    h.db.client.prepare(`INSERT INTO space_project_digests (id, project_key, page_id, page_source_id, page_source_version, page_updated_at,
      status, change_basis, digest_json, failure_code, generated_at) VALUES ('d1', 'smart-listing', 'page_1', ?, ?, ?, 'ready', 'first_snapshot', ?, NULL, ?)`)
      .run(page.id, page.sourceVersion, page.occurredAt, JSON.stringify(legacy), at.toISOString());
    expect(h.digests.getForPageSource(page.id)).toMatchObject({ status: 'ready', digest: legacy });
    expect(h.digests.getForPageSource(page.id)?.digest?.profile).toBeUndefined();
    const profiled = { ...legacy, profile: { ...noProfile, positioning: { text: '目标', blockId: 'b1', excerpt: '目标' } } };
    h.digests.saveReady({ ...base, changeBasis: 'first_snapshot', digest: profiled });
    expect(h.digests.getForPageSource(page.id)?.digest).toEqual(profiled);
    h.digests.saveReady({ ...base, changeBasis: 'first_snapshot', digest: { ...profiled, profile: noProfile } });
    expect(h.digests.getForPageSource(page.id)?.digest).toEqual(profiled);
  });

  it('returns the newest page version first', () => {
    const h = setup();
    const v1 = savePage(h.sources, '2026-10-20T01:00:00.000Z', [block('b1', 'a', '一')]);
    const v2 = savePage(h.sources, '2026-10-21T01:00:00.000Z', [block('b1', 'b', '二')]);
    for (const page of [v2, v1]) h.digests.saveFailed({ projectKey: 'smart-listing', pageId: 'page_1', pageSourceId: page.id,
      pageSourceVersion: page.sourceVersion, pageUpdatedAt: page.occurredAt, generatedAt: at, failureCode: 'X' });
    expect(h.digests.getLatestForProject('smart-listing')?.pageSourceId).toBe(v2.id);
  });
});
