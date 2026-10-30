import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type Database from 'better-sqlite3';
import { createSqliteDatabase } from '../db/client.js';
import { TopicRepository } from '../repositories/topic-repository.js';

export interface MergeFounderTopicsDependencies {
  client: Database.Database;
  now: () => Date;
  write: (line: string) => void;
}

/**
 * Merges a work-map duplicate that has no number on any card (so a founder cannot reply "第 X 项和第 Y 项是同一个项目")
 * into the item it duplicates, e.g. the hidden 「56 Bonnefin这个项目」 into 「56 Bonnefin 楼花展示项目总览」
 * (Ivy 2026-10-30). The merge is tried and rolled back first: it is refused unless `--into` stays the one shown — its
 * line, Space page and history keep their place. Preview is the default; --apply needs a change-sheet reference.
 * Nothing is deleted.
 */
export function runMergeFounderTopicsCli(args: readonly string[], dependencies: MergeFounderTopicsDependencies): number {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : [...args], strict: true, options: {
    into: { type: 'string' }, from: { type: 'string' }, apply: { type: 'boolean' }, 'change-ref': { type: 'string' } } });
  const into = values.into?.trim(), from = values.from?.trim(), changeRef = values['change-ref']?.trim();
  if (!into || !from || into === from || (values.apply && !changeRef)) throw new Error('MERGE_TOPICS_ARGUMENTS_INVALID');
  const topics = new TopicRepository(dependencies.client);
  const current = new Map(topics.listCurrentTopics().map((topic) => [topic.id, topic]));
  // The shown topic of `id`'s same_as group: the group member listCanonicalTopics keeps.
  const canonicalOf = (id: string) => {
    const edges = topics.listRelations().filter((relation) => relation.relationType === 'same_as');
    const group = new Set([id]);
    for (let grown = true; grown;) {
      grown = false;
      for (const edge of edges) for (const [a, b] of [[edge.fromTopicId, edge.toTopicId], [edge.toTopicId, edge.fromTopicId]] as const) {
        if (group.has(a) && !group.has(b)) { group.add(b); grown = true; }
      }
    }
    return topics.listCanonicalTopics().find((topic) => group.has(topic.id))?.id ?? null;
  };
  const merge = () => topics.addRelation({ fromTopicId: into!, toTopicId: from!, relationType: 'same_as',
    rationale: `Ivy 确认属于同一项目（${changeRef ?? 'preview'}）`, createdAt: dependencies.now() });
  /** Applies the relation inside a transaction that is always rolled back, and reports whether `--into` stays shown. */
  const mergeKeepsShown = () => {
    let kept = false;
    try { dependencies.client.transaction(() => { merge(); kept = canonicalOf(from!) === into && canonicalOf(into!) === into; throw rollback; })(); }
    catch (error) { if (error !== rollback) throw error; }
    return kept;
  };
  const target = current.get(into), duplicate = current.get(from);
  const preview = {
    into: target ? { id: target.id, name: target.displayName, stage: target.stage, createdAt: target.createdAt } : null,
    from: duplicate ? { id: duplicate.id, name: duplicate.displayName, stage: duplicate.stage, createdAt: duplicate.createdAt } : null,
    status: !target || !duplicate ? 'topic_not_found'
      : canonicalOf(into) !== into ? 'into_is_not_shown'
      : canonicalOf(from) === into ? 'already_merged'
      : mergeKeepsShown() ? 'ready' : 'would_replace_shown_topic'
  };
  if (!values.apply || preview.status !== 'ready') {
    dependencies.write(JSON.stringify({ mode: values.apply ? 'rejected' : 'preview', ...preview }, null, 2));
    return preview.status === 'ready' || preview.status === 'already_merged' ? 0 : 2;
  }
  dependencies.client.transaction(() => {
    merge();
    if (canonicalOf(from) !== into || canonicalOf(into) !== into) throw new Error('MERGE_TOPICS_CANONICAL_MOVED');
  })();
  dependencies.write(JSON.stringify({ mode: 'applied', ...preview, status: 'merged' }, null, 2));
  return 0;
}

const rollback = new Error('MERGE_TOPICS_PREVIEW_ROLLBACK');

function main(): void {
  const databasePath = process.env.DATABASE_URL?.trim();
  if (!databasePath || /^postgres(?:ql)?:/u.test(databasePath)) throw new Error('SQLite database path required');
  const database = createSqliteDatabase(databasePath);
  try {
    process.exitCode = runMergeFounderTopicsCli(process.argv.slice(2), { client: database.client, now: () => new Date(),
      write: (line) => process.stdout.write(`${line}\n`) });
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`Topic merge failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}\n`);
    process.exitCode = 1;
  }
}
