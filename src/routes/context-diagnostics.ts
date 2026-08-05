import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

export interface ContextDiagnostics {
  sources: { total: number; latestCapturedAt: string | null };
  extractionRuns: { processing: number; completed: number; failed: number };
  candidates: { pending: number; approved: number; rejected: number; needsClarification: number; conflict: number };
  records: { active: number; disputed: number; archived: number };
}

export function registerContextDiagnosticsRoute(app: FastifyInstance, client: Database.Database): void {
  app.get('/diag/context', async (): Promise<ContextDiagnostics> => {
    const sources = client.prepare('SELECT COUNT(*) AS total, MAX(captured_at) AS latest FROM context_sources').get() as CountLatest;
    const runs = client.prepare(`SELECT
      COALESCE(SUM(status = 'processing'), 0) AS processing,
      COALESCE(SUM(status = 'completed'), 0) AS completed,
      COALESCE(SUM(status = 'failed'), 0) AS failed FROM context_extraction_runs`).get() as RunCounts;
    const candidates = client.prepare(`SELECT
      COALESCE(SUM(review_status = 'pending'), 0) AS pending,
      COALESCE(SUM(review_status = 'approved'), 0) AS approved,
      COALESCE(SUM(review_status = 'rejected'), 0) AS rejected,
      COALESCE(SUM(review_status = 'needs_clarification'), 0) AS needs_clarification,
      COALESCE(SUM(review_status = 'conflict'), 0) AS conflict FROM context_candidates`).get() as CandidateCounts;
    const records = client.prepare(`SELECT
      COALESCE(SUM(lifecycle_status = 'active'), 0) AS active,
      COALESCE(SUM(lifecycle_status = 'disputed'), 0) AS disputed,
      COALESCE(SUM(lifecycle_status = 'archived'), 0) AS archived FROM context_records`).get() as RecordCounts;
    return {
      sources: { total: sources.total, latestCapturedAt: sources.latest },
      extractionRuns: runs,
      candidates: { pending: candidates.pending, approved: candidates.approved,
        rejected: candidates.rejected, needsClarification: candidates.needs_clarification,
        conflict: candidates.conflict },
      records
    };
  });
}

interface CountLatest { total: number; latest: string | null }
interface RunCounts { processing: number; completed: number; failed: number }
interface CandidateCounts { pending: number; approved: number; rejected: number; needs_clarification: number; conflict: number }
interface RecordCounts { active: number; disputed: number; archived: number }
