import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createSqliteDatabase } from '../db/client.js';
import { spaceSyncEnvelopeV1Schema } from '../domain/space-sync.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { buildSpaceMarkdownEnvelope } from '../services/space-markdown-envelope.js';
import { ingestSpaceSyncEnvelope } from '../services/space-sync-ingestion.js';

export interface SpaceAutoSubmitArguments {
  projectKey: string; markdownPath: string; title: string; updatedAt: string; maxBytes: number;
}

export interface SpaceAutoSubmitDependencies {
  client: Database.Database;
  readFile: (path: string) => string;
  now: () => Date;
  write: (line: string) => void;
}

export function parseSpaceAutoSubmitArguments(args: readonly string[]): SpaceAutoSubmitArguments {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : [...args], strict: true, options: {
    'project-key': { type: 'string' }, markdown: { type: 'string' }, title: { type: 'string' },
    'updated-at': { type: 'string' }, 'max-bytes': { type: 'string' } } });
  const projectKey = values['project-key']?.trim(), markdownPath = values.markdown?.trim(), title = values.title?.trim(),
    updatedAt = values['updated-at']?.trim(), maxBytes = Number(values['max-bytes'] ?? '1000000');
  if (!projectKey || !markdownPath || !title || title.length > 200 || !updatedAt ||
    !z.string().datetime({ offset: true }).safeParse(updatedAt).success || !Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('SPACE_AUTO_SUBMIT_ARGUMENTS_INVALID');
  }
  return { projectKey, markdownPath, title, updatedAt, maxBytes };
}

/**
 * One hourly page read from Ivy's local Codex App (T2), handed over by the restricted
 * `deploy/space-submit.sh` key. The page is looked up from the registered binding, never
 * from the caller, and goes through the same ingestion as a manual import; an identical
 * read only refreshes the sync time. Prints counts only, never page text.
 */
export function runSpaceAutoSubmitCli(args: readonly string[], dependencies: SpaceAutoSubmitDependencies): void {
  const options = parseSpaceAutoSubmitArguments(args);
  const spaceSyncRepository = new SpaceSyncRepository(dependencies.client);
  const binding = spaceSyncRepository.getBindingByProjectKey(options.projectKey);
  if (!binding) throw new Error('SPACE_AUTO_SUBMIT_PROJECT_NOT_REGISTERED');
  const markdown = dependencies.readFile(options.markdownPath);
  if (Buffer.byteLength(markdown, 'utf8') > options.maxBytes) throw new Error('SPACE_AUTO_SUBMIT_TOO_LARGE');
  if (!markdown.trim()) throw new Error('SPACE_AUTO_SUBMIT_EMPTY');
  const envelope = spaceSyncEnvelopeV1Schema.parse(buildSpaceMarkdownEnvelope({
    markdown, projectKey: options.projectKey, page: { pageId: binding.pageId, url: binding.pageUrl }, title: options.title,
    capturedAt: dependencies.now(), updatedAt: options.updatedAt, trigger: 'scheduled'
  }));
  const result = ingestSpaceSyncEnvelope(envelope, {
    client: dependencies.client, spaceSyncRepository, contextSourceRepository: new ContextSourceRepository(dependencies.client),
    limits: { maxBlocks: 500, maxComments: 2000 }, now: dependencies.now
  });
  dependencies.write(JSON.stringify({
    projectKey: options.projectKey, syncId: result.syncId, unchanged: result.unchanged,
    pageSourceCreated: !result.unchanged && result.run.pageSourceCreated, blocks: envelope.page.blocks.length,
    characters: envelope.page.blocks.reduce((total, block) => total + block.markdown.length, 0), updatedAt: envelope.page.updatedAt
  }));
}

function main(): void {
  const databasePath = process.env.DATABASE_URL?.trim();
  if (!databasePath || /^postgres(?:ql)?:/u.test(databasePath)) throw new Error('SQLite database path required');
  const database = createSqliteDatabase(databasePath);
  try {
    runSpaceAutoSubmitCli(process.argv.slice(2), { client: database.client, readFile: (path) => readFileSync(path, 'utf8'),
      now: () => new Date(), write: (line) => process.stdout.write(`${line}\n`) });
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'SPACE_AUTO_SUBMIT_FAILED';
    process.stderr.write(`${code}. No page content logged.\n`);
    process.exitCode = 1;
  }
}
