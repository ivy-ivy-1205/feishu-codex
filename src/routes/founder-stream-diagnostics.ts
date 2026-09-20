import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const pageStatus = z.enum(['read', 'unavailable', 'cursor_repeated', 'pagination_invalid']);
const coverageSchema = z.object({
  requestedRange: z.object({ since: instant, until: instant }),
  coverageStatus: z.enum(['partial', 'visible_range_exhausted']),
  coverage: z.object({ rootPages: z.number().int().nonnegative(), threadPages: z.number().int().nonnegative(), threadsDiscovered: z.number().int().nonnegative() }),
  sourceCoverage: z.object({
    observedMessageTimeRange: z.object({ earliest: instant.nullable(), latest: instant.nullable() }),
    termination: z.enum(['next_cursor_null', 'incomplete']),
    pages: z.array(z.object({ kind: z.enum(['root', 'thread']), threadId: z.string().nullable(),
      requestCursor: z.string().nullable(), nextCursor: z.string().nullable(), status: pageStatus }))
  })
});
const sourceTypes = ['group_message', 'minute_transcript', 'feishu_chat_message', 'feishu_file', 'feishu_sync_coverage', 'feishu_sync_gap'];
const sourceStatuses = ['available', 'deleted', 'permission_lost', 'unknown'];
const stages = ['idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed'];
const gapCodes = ['PAGINATION_CURSOR_REPEATED', 'PAGINATION_STATE_INVALID', 'ROOT_PAGE_UNAVAILABLE', 'THREAD_PAGE_UNAVAILABLE',
  'MESSAGE_TIME_INVALID', 'MESSAGE_DELETED', 'MEDIA_SKIPPED', 'IMAGE_SKIPPED', 'VOICE_TEXT_MISSING', 'MESSAGE_TEXT_UNAVAILABLE',
  'MESSAGE_UNSUPPORTED', 'REFERENCED_FILES_UNAVAILABLE', 'FILE_REFERENCE_UNAVAILABLE', 'FILE_TEXT_UNREADABLE', 'MESSAGE_INVALID'];
const jobStates = ['queued', 'retry', 'processing', 'completed', 'failed'];
const outboxStates = ['pending', 'delivered', 'failed', 'cancelled'];

/** Mirrors the existing aggregate /diag registration. Network access control is an operator prerequisite. */
export function registerFounderStreamDiagnosticsRoute(app: FastifyInstance, client: Database.Database): void {
  app.get('/diag/founder-stream', async (_request, reply) => {
    try { return client.transaction(() => collectDiagnostics(client))(); }
    catch { return reply.code(503).send({ error: 'FOUNDER_STREAM_DIAGNOSTICS_UNAVAILABLE' }); }
  });
}

function collectDiagnostics(client: Database.Database) {
  // Select counts or audit envelopes only. Never select message/Minutes text, identity rows, job payloads or outbox payloads.
  const typeRows = client.prepare('SELECT source_type AS label, COUNT(*) AS n FROM context_sources GROUP BY source_type').all() as CountRow[];
  const statusRows = client.prepare('SELECT availability_status AS label, COUNT(*) AS n FROM context_sources GROUP BY availability_status').all() as CountRow[];
  const audits = client.prepare("SELECT content_text, captured_at FROM context_sources WHERE source_type='feishu_sync_coverage' ORDER BY captured_at DESC, id DESC").all() as { content_text: string; captured_at: string }[];
  const parsed = audits.map(row => ({ value: parseCoverage(row.content_text), at: instant.safeParse(row.captured_at) }));
  const latest = parsed[0];
  const gapRows = client.prepare("SELECT content_text FROM context_sources WHERE source_type='feishu_sync_gap'").all() as { content_text: string }[];
  const gapsByCode: Record<string, number> = {};
  for (const row of gapRows) {
    let code = 'UNKNOWN';
    try { const value: unknown = JSON.parse(row.content_text); const result = z.object({ code: z.string() }).safeParse(value);
      if (result.success && gapCodes.includes(result.data.code)) code = result.data.code;
    } catch { /* Invalid audits remain counted, not echoed. */ }
    gapsByCode[code] = (gapsByCode[code] ?? 0) + 1;
  }
  const topicRows = client.prepare('SELECT v.stage AS label, COUNT(*) AS n FROM context_topics t JOIN context_topic_versions v ON v.topic_id=t.id AND v.version_number=t.current_version GROUP BY v.stage').all() as CountRow[];
  const issueRows = client.prepare("SELECT status AS label, COUNT(*) AS n FROM alignment_issues WHERE status IN ('candidate','ready','asked') GROUP BY status").all() as CountRow[];
  const issues = counts(issueRows, ['candidate', 'ready', 'asked'], true);
  const jobs: Record<string, Record<string, number>> = {};
  for (const type of ['capture_group_message', 'analyze_founder_stream_batch']) {
    jobs[type] = counts(client.prepare('SELECT status AS label, COUNT(*) AS n FROM batch_jobs WHERE type=? GROUP BY status').all(type) as CountRow[], jobStates, true);
  }
  const outbox = counts(client.prepare("SELECT status AS label, COUNT(*) AS n FROM outbox WHERE idempotency_key LIKE 'founder-%' OR idempotency_key LIKE 'alignment-%' GROUP BY status").all() as CountRow[], outboxStates);
  return {
    scope: 'local_persisted_founder_stream_aggregates',
    coverage: { snapshots: audits.length, invalidSnapshots: parsed.filter(p => !p.value || !p.at.success).length,
      latest: latest?.value && latest.at.success ? { requestedWindow: latest.value.requestedRange,
        observedWindow: latest.value.sourceCoverage.observedMessageTimeRange, status: latest.value.coverageStatus,
        termination: latest.value.sourceCoverage.termination, pages: latest.value.coverage,
        cursorState: cursorState(latest.value, latest.at.data) } : null },
    sources: { total: typeRows.reduce((sum, row) => sum + row.n, 0), byType: counts(typeRows, sourceTypes), byStatus: counts(statusRows, sourceStatuses) },
    topicsByStage: counts(topicRows, stages, true), openAlignmentIssues: { ...issues, total: issueRows.reduce((sum, row) => sum + row.n, 0) },
    gapsByCode, jobs, outbox
  };
}

function parseCoverage(text: string): z.infer<typeof coverageSchema> | null {
  try { const result = coverageSchema.safeParse(JSON.parse(text)); return result.success ? result.data : null; }
  catch { return null; }
}
function cursorState(coverage: z.infer<typeof coverageSchema>, at: string) {
  const result = {} as Record<'root' | 'thread', { count: number; present: boolean; status: string; lastUpdatedAt: string | null }>;
  for (const kind of ['root', 'thread'] as const) {
    const latest = new Map<string | null, typeof coverage.sourceCoverage.pages[number]>();
    for (const page of coverage.sourceCoverage.pages) if (page.kind === kind) latest.set(page.threadId, page);
    const pages = [...latest.values()];
    const count = pages.filter(p => Boolean(p.nextCursor || (p.status !== 'read' && p.requestCursor))).length;
    const statuses = [...new Set(pages.map(p => p.status))];
    result[kind] = { count, present: count > 0, status: statuses.length === 0 ? 'not_observed' : statuses.length === 1 ? statuses[0]! : 'mixed',
      lastUpdatedAt: pages.length ? at : null };
  }
  return result;
}
interface CountRow { label: string; n: number }
function counts(rows: CountRow[], labels: readonly string[], includeZeros = false): Record<string, number> {
  const result: Record<string, number> = includeZeros ? Object.fromEntries(labels.map(label => [label, 0])) : {};
  for (const row of rows) { const label = labels.includes(row.label) ? row.label : 'other'; result[label] = (result[label] ?? 0) + row.n; }
  return result;
}
