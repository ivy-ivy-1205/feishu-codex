import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import {
  parseImportSpaceSyncArguments,
  runImportSpaceSyncCli
} from '../src/cli/import-space-sync.js';

function fixtureEnvelopeJson(): string {
  return JSON.stringify({
    schemaVersion: 1, syncId: 'sync_fixture_1', projectKey: 'smart_listing', trigger: 'manual',
    capturedAt: '2026-10-19T00:00:00.000Z',
    page: {
      pageId: 'page_1', spaceId: null, url: 'https://chatgpt.com/space/page_1',
      title: 'Smart Listing 总览', sequence: 1, updatedAt: '2026-10-18T10:00:00.000Z',
      blocks: [{ id: 'block_1', hash: 'a'.repeat(64), markdown: '当前阶段：试点' }]
    },
    comments: [],
    coverage: { pageComplete: true, commentsComplete: true, nextCursor: null, gaps: [] }
  });
}

function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  const spaceSyncRepository = new SpaceSyncRepository(database.client);
  const contextSourceRepository = new ContextSourceRepository(database.client);
  spaceSyncRepository.createBinding({
    id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual',
    createdAt: new Date('2026-10-19T00:00:00.000Z')
  });
  return { database, spaceSyncRepository, contextSourceRepository };
}

describe('parseImportSpaceSyncArguments', () => {
  it('requires an --envelope path', () => {
    expect(() => parseImportSpaceSyncArguments([])).toThrow('SPACE_SYNC_IMPORT_ARGUMENTS_INVALID');
    expect(parseImportSpaceSyncArguments(['--envelope', 'fixture.json']))
      .toEqual({ envelopePath: 'fixture.json', maxBlocks: 500, maxComments: 2_000 });
  });
});

describe('runImportSpaceSyncCli', () => {
  it('reads a fixture envelope file and ingests it through the same validated service', () => {
    const { database, spaceSyncRepository, contextSourceRepository } = setup();
    const lines: string[] = [];
    runImportSpaceSyncCli(['--envelope', 'fixture.json'], {
      readFile: () => fixtureEnvelopeJson(),
      client: database.client, spaceSyncRepository, contextSourceRepository,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
      write: (line) => lines.push(line)
    });
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0] ?? '{}');
    expect(output).toMatchObject({ syncId: 'sync_fixture_1', replay: false, pageSourceCreated: true });
    expect(contextSourceRepository.listSources()).toHaveLength(2);
  });

  it('rejects a fixture file that fails schema validation without writing anything', () => {
    const { database, spaceSyncRepository, contextSourceRepository } = setup();
    expect(() => runImportSpaceSyncCli(['--envelope', 'bad.json'], {
      readFile: () => JSON.stringify({ schemaVersion: 2 }),
      client: database.client, spaceSyncRepository, contextSourceRepository,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
      write: () => {}
    })).toThrow();
    expect(contextSourceRepository.listSources()).toHaveLength(0);
  });
});
