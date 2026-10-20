import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { spaceSyncEnvelopeV1Schema } from '../src/domain/space-sync.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { diffSpacePageBlocks } from '../src/services/space-page-diff.js';
import { ingestSpaceSyncEnvelope } from '../src/services/space-sync-ingestion.js';
import { buildSpaceMarkdownEnvelope, markdownPageUpdatedAt, spaceMarkdownBlocks } from '../src/services/space-markdown-envelope.js';
import { parseSpaceMarkdownEnvelopeArguments, runSpaceMarkdownEnvelopeCli } from '../src/cli/space-markdown-envelope.js';

const page = { pageId: 'page_f095', url: 'https://chatgpt.com/space/page_f095' };
const capturedAt = new Date('2026-10-21T02:00:00.000Z');
const markdown = [
  '更新于 2026 年 10 月 19 日。本页汇总两条工作线的当前成果。',
  '',
  '## 本轮进展',
  '',
  '| Task | 能力 |',
  '| - | - |',
  '| 1 | 统一核心 |',
  '',
  '- 客户体验更连贯',
  '',
  '- 客户体验更连贯',
  ''
].join('\r\n');

describe('Space page Markdown → sync envelope', () => {
  it('splits on blank lines, keeps a table as one block and gives repeated text distinct stable ids', () => {
    const blocks = spaceMarkdownBlocks(markdown);
    expect(blocks.map((block) => block.markdown)).toEqual([
      '更新于 2026 年 10 月 19 日。本页汇总两条工作线的当前成果。',
      '## 本轮进展',
      '| Task | 能力 |\n| - | - |\n| 1 | 统一核心 |',
      '- 客户体验更连贯',
      '- 客户体验更连贯'
    ]);
    expect(blocks.every((block) => /^[a-f0-9]{64}$/u.test(block.hash))).toBe(true);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    expect(spaceMarkdownBlocks(markdown)).toEqual(blocks);
  });

  it('marks only the edited paragraph as changed between two exports', () => {
    const before = spaceMarkdownBlocks(markdown);
    const after = spaceMarkdownBlocks(markdown.replace('统一核心', '统一核心与工具'));
    expect(diffSpacePageBlocks(before, after)).toMatchObject({ added: [after[2]!.id], removed: [before[2]!.id] });
  });

  it('reads the page date from the leading 更新于 line as a UTC+8 date', () => {
    expect(markdownPageUpdatedAt(markdown)).toBe('2026-10-19T00:00:00+08:00');
    expect(markdownPageUpdatedAt('没有日期的页面')).toBeNull();
  });

  it('builds a valid manual envelope that says comments were not exported', () => {
    const envelope = buildSpaceMarkdownEnvelope({ markdown, projectKey: 'smart-listing', page, title: 'Smart Listing 总览', capturedAt });
    expect(spaceSyncEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({ schemaVersion: 1, projectKey: 'smart-listing', trigger: 'manual', capturedAt: capturedAt.toISOString(),
      comments: [], page: { pageId: 'page_f095', url: page.url, title: 'Smart Listing 总览', spaceId: null, sequence: null,
        updatedAt: '2026-10-19T00:00:00+08:00' },
      coverage: { pageComplete: true, commentsComplete: false, nextCursor: null,
        gaps: [{ code: 'comments_not_exported', summary: expect.any(String) }] } });
    expect(envelope.syncId).toMatch(/^md-page_f095-20261021T020000Z$/u);
  });

  it('flags an unknown page date instead of inventing one, and lets an explicit date win', () => {
    const undated = buildSpaceMarkdownEnvelope({ markdown: '## 只有标题', projectKey: 'smart-listing', page, title: 't', capturedAt });
    expect(undated.page.updatedAt).toBeNull();
    expect(undated.coverage.gaps.map((gap) => gap.code)).toEqual(['comments_not_exported', 'page_updated_at_unknown']);
    const dated = buildSpaceMarkdownEnvelope({ markdown, projectKey: 'smart-listing', page, title: 't', capturedAt,
      updatedAt: '2026-10-20T09:00:00+08:00' });
    expect(dated.page.updatedAt).toBe('2026-10-20T09:00:00+08:00');
  });

  it('ingests through the normal path, and a second export of unchanged text stores no new page version', () => {
    const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
    db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
      VALUES ('smart-listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(capturedAt.toISOString(), capturedAt.toISOString());
    const spaceSyncRepository = new SpaceSyncRepository(db.client), contextSourceRepository = new ContextSourceRepository(db.client);
    spaceSyncRepository.createBinding({ id: 'b1', projectKey: 'smart-listing', spaceId: null, pageId: page.pageId, pageUrl: page.url,
      managementMode: 'hybrid', syncMode: 'manual', createdAt: capturedAt });
    const deps = { client: db.client, spaceSyncRepository, contextSourceRepository, limits: { maxBlocks: 500, maxComments: 2000 }, now: () => capturedAt };
    const first = ingestSpaceSyncEnvelope(buildSpaceMarkdownEnvelope({ markdown, projectKey: 'smart-listing', page, title: 't', capturedAt }), deps);
    const later = new Date(capturedAt.getTime() + 3_600_000);
    const second = ingestSpaceSyncEnvelope(buildSpaceMarkdownEnvelope({ markdown, projectKey: 'smart-listing', page, title: 't', capturedAt: later }), deps);
    expect(first.run.pageSourceCreated).toBe(true);
    expect(second.run.pageSourceCreated).toBe(false);
    expect(contextSourceRepository.listSources().filter((source) => source.sourceType === 'space_page_snapshot')).toHaveLength(1);
    db.close();
  });
});

describe('space-markdown-envelope CLI', () => {
  const plan = JSON.stringify({ projects: [{ projectKey: 'smart-listing', displayName: 'Smart Listing',
    page: { pageId: 'page_f095', pageUrl: 'https://chatgpt.com/space/page_f095', managementMode: 'hybrid', syncMode: 'manual' } }], authors: [] });
  const args = ['--plan', 'plan.json', '--project-key', 'smart-listing', '--markdown', '/in/Smart Listing 总览.md', '--out', '/out/envelope.json'];

  it('requires plan, project, markdown and output paths', () => {
    expect(parseSpaceMarkdownEnvelopeArguments(args)).toMatchObject({ projectKey: 'smart-listing', title: null, updatedAt: null });
    expect(() => parseSpaceMarkdownEnvelopeArguments(args.slice(2))).toThrow(/ARGUMENTS_INVALID/);
    expect(() => parseSpaceMarkdownEnvelopeArguments([...args, '--updated-at', 'yesterday'])).toThrow(/ARGUMENTS_INVALID/);
  });

  it('takes the page from the registration plan, titles it from the file name and prints counts only', () => {
    const written: Record<string, string> = {}, lines: string[] = [];
    runSpaceMarkdownEnvelopeCli(args, { readFile: (path) => (path === 'plan.json' ? plan : markdown), now: () => capturedAt,
      writeNewFile: (path, content) => { written[path] = content; }, write: (line) => lines.push(line) });
    const envelope = spaceSyncEnvelopeV1Schema.parse(JSON.parse(written['/out/envelope.json']!));
    expect(envelope.page).toMatchObject({ pageId: 'page_f095', url: 'https://chatgpt.com/space/page_f095', title: 'Smart Listing 总览' });
    const report = JSON.parse(lines.join('\n'));
    expect(report).toMatchObject({ syncId: envelope.syncId, blocks: 5, updatedAt: '2026-10-19T00:00:00+08:00',
      pageComplete: true, commentsComplete: false, gaps: ['comments_not_exported'], envelopePath: '/out/envelope.json' });
    expect(report.envelopeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(lines.join('\n')).not.toContain('统一核心');
  });

  it('refuses a project that is not in the registration plan', () => {
    expect(() => runSpaceMarkdownEnvelopeCli(['--plan', 'plan.json', '--project-key', 'family-first', '--markdown', 'a.md', '--out', 'o.json'],
      { readFile: (path) => (path === 'plan.json' ? plan : markdown), now: () => capturedAt, writeNewFile: () => undefined, write: () => undefined }))
      .toThrow(/SPACE_MARKDOWN_PROJECT_NOT_REGISTERED/);
  });
});
