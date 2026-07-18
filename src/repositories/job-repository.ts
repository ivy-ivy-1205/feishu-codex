import type Database from 'better-sqlite3';

export interface DurableJob {
  kind: 'process_minute';
  key: string;
  minuteId: string;
  attempt: number;
  leaseExpiresAt?: string;
}

export class JobRepository {
  constructor(readonly client: Database.Database) {}

  enqueueProcessMinute(minuteId: string): { created: boolean; job: DurableJob } {
    const job: DurableJob = {
      kind: 'process_minute',
      key: `minute:${minuteId}`,
      minuteId,
      attempt: 0
    };
    const now = new Date().toISOString();
    const result = this.client.prepare(`
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(stable_key) DO NOTHING
    `).run(
      job.key,
      job.kind,
      job.key,
      JSON.stringify({ minuteId: job.minuteId }),
      now,
      now
    );

    return { created: result.changes === 1, job };
  }

  list(): DurableJob[] {
    const rows = this.client.prepare(`
      SELECT type, stable_key, payload
      FROM batch_jobs
      ORDER BY created_at ASC
    `).all() as JobRow[];

    return rows.map((row) => ({
      kind: row.type,
      key: row.stable_key,
      minuteId: parseJobPayload(row.payload).minuteId,
      attempt: parseJobPayload(row.payload).attempt ?? 0
    }));
  }

  leaseNextProcessMinute(availableAt: Date): DurableJob | null {
    const leaseUntil = new Date(availableAt.getTime() + 60_000);
    return this.client.transaction(() => {
      const row = this.client.prepare(`
        SELECT type, stable_key, payload
        FROM batch_jobs
        WHERE type = 'process_minute'
          AND status IN ('queued', 'retry', 'processing')
          AND updated_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(availableAt.toISOString()) as JobRow | undefined;
      if (!row) {
        return null;
      }

      const leased = this.client.prepare(`
        UPDATE batch_jobs
        SET status = 'processing', updated_at = ?
        WHERE stable_key = ?
          AND status IN ('queued', 'retry', 'processing')
          AND updated_at <= ?
      `).run(leaseUntil.toISOString(), row.stable_key, availableAt.toISOString());
      if (leased.changes !== 1) {
        return null;
      }

      const payload = parseJobPayload(row.payload);
      return {
        kind: row.type,
        key: row.stable_key,
        minuteId: payload.minuteId,
        attempt: payload.attempt ?? 0,
        leaseExpiresAt: leaseUntil.toISOString()
      };
    })();
  }

  markCompleted(job: DurableJob, completedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    this.client.prepare(`
      UPDATE batch_jobs
      SET status = 'completed', updated_at = ?
      WHERE stable_key = ?
        AND status = 'processing'
        AND updated_at = ?
        AND updated_at > ?
    `).run(
      completedAt.toISOString(),
      job.key,
      leaseExpiresAt,
      completedAt.toISOString()
    );
  }

  ownsLease(job: DurableJob, at: Date): boolean {
    const leaseExpiresAt = requireLease(job);
    const row = this.client.prepare(`
      SELECT 1
      FROM batch_jobs
      WHERE stable_key = ?
        AND status = 'processing'
        AND updated_at = ?
        AND updated_at > ?
    `).get(job.key, leaseExpiresAt, at.toISOString());
    return Boolean(row);
  }

  markRetry(job: DurableJob, availableAt: Date, attemptedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    this.client.prepare(`
      UPDATE batch_jobs
      SET status = 'retry', payload = ?, updated_at = ?
      WHERE stable_key = ?
        AND status = 'processing'
        AND updated_at = ?
        AND updated_at > ?
    `).run(
      JSON.stringify({ minuteId: job.minuteId, attempt: job.attempt + 1 }),
      availableAt.toISOString(),
      job.key,
      leaseExpiresAt,
      attemptedAt.toISOString()
    );
  }

  markFailed(job: DurableJob, failureReason: string, failedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    this.client.prepare(`
      UPDATE batch_jobs
      SET status = 'failed', payload = ?, updated_at = ?
      WHERE stable_key = ?
        AND status = 'processing'
        AND updated_at = ?
        AND updated_at > ?
    `).run(
      JSON.stringify({ minuteId: job.minuteId, failureReason }),
      failedAt.toISOString(),
      job.key,
      leaseExpiresAt,
      failedAt.toISOString()
    );
  }
}

interface JobRow {
  type: DurableJob['kind'];
  stable_key: string;
  payload: string;
}

interface JobPayload {
  minuteId: string;
  attempt?: number;
}

function parseJobPayload(payload: string): JobPayload {
  return JSON.parse(payload) as JobPayload;
}

function requireLease(job: DurableJob): string {
  if (!job.leaseExpiresAt) {
    throw new Error('job must be leased before its status can change');
  }
  return job.leaseExpiresAt;
}
