import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { runSpaceAutoSubmitCli, spaceAutoSubmitErrorLine } from '../src/cli/space-auto-submit.js';

const page = '更新于 2026 年 10 月 25 日\n\n# 正在做\n\nPhase 6 资料接入。\n';

function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('feishu-adaptor', '飞书合伙人对齐', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`)
    .run('2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
  new SpaceSyncRepository(database.client).createBinding({ id: 'binding-c', projectKey: 'feishu-adaptor', spaceId: null,
    pageId: 'page_c', pageUrl: 'https://chatgpt.com/space/page_c', managementMode: 'hybrid', syncMode: 'manual',
    createdAt: new Date('2026-10-22T00:00:00.000Z') });
  const lines: string[] = [];
  let clock = new Date('2026-10-26T01:00:00.000Z');
  const files = new Map<string, string>([['/tmp/page.md', page]]);
  const run = (args: string[]) => runSpaceAutoSubmitCli(args, { client: database.client, readFile: (path) => {
    const content = files.get(path); if (content === undefined) throw new Error('ENOENT'); return content;
  }, now: () => clock, write: (line) => lines.push(line) });
  return { database, lines, files, run, tick: (iso: string) => { clock = new Date(iso); } };
}

const args = ['--project-key', 'feishu-adaptor', '--markdown', '/tmp/page.md', '--title=AiJia 合伙人对齐室项目总览',
  '--updated-at', '2026-10-25T11:22:59.146Z'];

describe('space-auto-submit CLI', () => {
  it('turns one scheduled page read into a scheduled sync of the registered page, printing counts only', () => {
    const { database, lines, run } = setup();
    run(args);
    const output = JSON.parse(lines[0]!);
    expect(output).toEqual({ projectKey: 'feishu-adaptor', syncId: 'auto-page_c-20261026T010000Z', unchanged: false,
      pageSourceCreated: true, blocks: 3, characters: 38, updatedAt: '2026-10-25T11:22:59.146Z' });
    expect(lines[0]).not.toContain('资料接入');
    const run0 = database.client.prepare('SELECT trigger, gap_count FROM space_sync_runs').get();
    expect(run0).toEqual({ trigger: 'scheduled', gap_count: 1 });
    const gap = new ContextSourceRepository(database.client).listSources().find((source) => source.sourceType === 'space_sync_gap');
    expect(gap?.contentText).toBe('评论未同步：本次由本机定时读取，只含页面正文。');
    const snapshot = new ContextSourceRepository(database.client).listSources().find((source) => source.sourceType === 'space_page_snapshot');
    expect(snapshot?.metadata.title).toBe('AiJia 合伙人对齐室项目总览');
  });

  it('reports an identical hourly read as unchanged and only moves the sync time', () => {
    const { database, lines, run, tick } = setup();
    run(args);
    tick('2026-10-26T02:00:00.000Z');
    run(args);
    expect(JSON.parse(lines[1]!)).toMatchObject({ syncId: 'auto-page_c-20261026T020000Z', unchanged: true, pageSourceCreated: false });
    expect(database.client.prepare('SELECT count(*) n FROM space_sync_runs').get()).toEqual({ n: 1 });
    expect(new SpaceSyncRepository(database.client).getBindingByProjectKey('feishu-adaptor')?.lastSuccessfulSyncAt)
      .toBe('2026-10-26T02:00:00.000Z');
  });

  it('refuses a project that has no registered page, an empty read, an oversized read and a bad time', () => {
    const { files, run } = setup();
    expect(() => run(['--project-key', 'smart-listing', ...args.slice(2)])).toThrow('SPACE_AUTO_SUBMIT_PROJECT_NOT_REGISTERED');
    files.set('/tmp/page.md', ' \n');
    expect(() => run(args)).toThrow('SPACE_AUTO_SUBMIT_EMPTY');
    files.set('/tmp/page.md', '字'.repeat(400_000));
    expect(() => run(args)).toThrow('SPACE_AUTO_SUBMIT_TOO_LARGE');
    files.set('/tmp/page.md', page);
    expect(() => run([...args.slice(0, 5), '--updated-at', '10-25'])).toThrow('SPACE_AUTO_SUBMIT_ARGUMENTS_INVALID');
    expect(() => run(args.filter((arg) => !arg.startsWith('--title')))).toThrow('SPACE_AUTO_SUBMIT_ARGUMENTS_INVALID');
  });
  it('names the kind of failure without page text, so a rejected submit can be diagnosed from the log (2026-10-30)', () => {
    expect(spaceAutoSubmitErrorLine(new Error('SPACE_AUTO_SUBMIT_EMPTY'))).toBe('SPACE_AUTO_SUBMIT_EMPTY. No page content logged.');
    expect(spaceAutoSubmitErrorLine(Object.assign(new Error('database is locked'), { name: 'SqliteError', code: 'SQLITE_BUSY' })))
      .toBe('SPACE_AUTO_SUBMIT_FAILED (SqliteError SQLITE_BUSY). No page content logged.');
    expect(spaceAutoSubmitErrorLine(Object.assign(new Error('space_sync_envelope_conflict'), { name: 'SpaceSyncIngestionError',
      code: 'space_sync_envelope_conflict' }))).toBe('SPACE_AUTO_SUBMIT_FAILED (SpaceSyncIngestionError space_sync_envelope_conflict). No page content logged.');
    // A message could quote the page, so only the error's name and a code-shaped code are ever printed.
    expect(spaceAutoSubmitErrorLine(new TypeError('页面正文 secret'))).toBe('SPACE_AUTO_SUBMIT_FAILED (TypeError). No page content logged.');
    expect(spaceAutoSubmitErrorLine(Object.assign(new Error('x'), { code: 'has spaces 页面' }))).toBe('SPACE_AUTO_SUBMIT_FAILED (Error). No page content logged.');
  });
});
