import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../services/canonical-json.js';
import { spaceSyncEnvelopeV1Schema } from '../domain/space-sync.js';
import { buildSpaceMarkdownEnvelope } from '../services/space-markdown-envelope.js';

export interface SpaceMarkdownEnvelopeArguments {
  planPath: string; projectKey: string; markdownPath: string; outPath: string; title: string | null; updatedAt: string | null;
}

export interface SpaceMarkdownEnvelopeDependencies {
  readFile: (path: string) => string;
  now: () => Date;
  /** Must refuse to overwrite: an envelope is an audit record of one export. */
  writeNewFile: (path: string, content: string) => void;
  write: (line: string) => void;
}

const planSchema = z.object({ projects: z.array(z.object({ projectKey: z.string(),
  page: z.object({ pageId: z.string().min(1), pageUrl: z.string().url() }).passthrough() }).passthrough()) }).passthrough();

export function parseSpaceMarkdownEnvelopeArguments(args: readonly string[]): SpaceMarkdownEnvelopeArguments {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : [...args], strict: true, options: {
    plan: { type: 'string' }, 'project-key': { type: 'string' }, markdown: { type: 'string' }, out: { type: 'string' },
    title: { type: 'string' }, 'updated-at': { type: 'string' } } });
  const planPath = values.plan?.trim(), projectKey = values['project-key']?.trim(), markdownPath = values.markdown?.trim(),
    outPath = values.out?.trim(), title = values.title?.trim() || null, updatedAt = values['updated-at']?.trim() || null;
  if (!planPath || !projectKey || !markdownPath || !outPath ||
    (updatedAt !== null && !z.string().datetime({ offset: true }).safeParse(updatedAt).success)) {
    throw new Error('SPACE_MARKDOWN_ARGUMENTS_INVALID');
  }
  return { planPath, projectKey, markdownPath, outPath, title, updatedAt };
}

/** Converts one saved page to an envelope file for `space-sync:import`; prints counts only, never page text. */
export function runSpaceMarkdownEnvelopeCli(args: readonly string[], dependencies: SpaceMarkdownEnvelopeDependencies): void {
  const options = parseSpaceMarkdownEnvelopeArguments(args);
  const plan = planSchema.parse(JSON.parse(dependencies.readFile(options.planPath)));
  const project = plan.projects.find((entry) => entry.projectKey === options.projectKey);
  if (!project) throw new Error('SPACE_MARKDOWN_PROJECT_NOT_REGISTERED');
  const envelope = spaceSyncEnvelopeV1Schema.parse(buildSpaceMarkdownEnvelope({
    markdown: dependencies.readFile(options.markdownPath), projectKey: options.projectKey,
    page: { pageId: project.page.pageId, url: project.page.pageUrl },
    title: options.title ?? basename(options.markdownPath).replace(/\.md$/iu, ''),
    capturedAt: dependencies.now(), updatedAt: options.updatedAt
  }));
  const content = `${canonicalJson(envelope)}\n`;
  dependencies.writeNewFile(options.outPath, content);
  dependencies.write(JSON.stringify({
    syncId: envelope.syncId, pageId: envelope.page.pageId, blocks: envelope.page.blocks.length,
    characters: envelope.page.blocks.reduce((total, block) => total + block.markdown.length, 0),
    updatedAt: envelope.page.updatedAt, pageComplete: envelope.coverage.pageComplete,
    commentsComplete: envelope.coverage.commentsComplete, gaps: envelope.coverage.gaps.map((gap) => gap.code),
    envelopePath: options.outPath, envelopeSha256: sha256(content)
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSpaceMarkdownEnvelopeCli(process.argv.slice(2), { readFile: (path) => readFileSync(path, 'utf8'), now: () => new Date(),
      writeNewFile: (path, content) => writeFileSync(path, content, { flag: 'wx', mode: 0o600 }),
      write: (line) => process.stdout.write(`${line}\n`) });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'SPACE_MARKDOWN_ENVELOPE_FAILED';
    process.stderr.write(`${code}. No page content logged.\n`);
    process.exitCode = 1;
  }
}
