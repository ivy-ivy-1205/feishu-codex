import type Database from 'better-sqlite3';

export interface DurableJob {
  kind: 'process_minute';
  key: string;
  minuteId: string;
  subscriberOpenIds?: string[];
  attemptsByCode: RetryAttemptsByCode;
  leaseExpiresAt?: string;
}

export type RetryErrorCode = 'MINUTE_NOT_READY' | 'RATE_LIMITED';

export interface RetryAttemptsByCode {
  MINUTE_NOT_READY: number;
  RATE_LIMITED: number;
}

export interface ProcessMinuteJobPayload {
  minuteId: string;
  subscriberOpenIds: string[];
  attemptsByCode: RetryAttemptsByCode;
  failureReason?: string;
}

export interface EnqueueProcessMinuteOptions {
  subscriberOpenIds?: string[];
}

const zeroRetryAttempts = (): RetryAttemptsByCode => ({
  MINUTE_NOT_READY: 0,
  RATE_LIMITED: 0
});

export const defaultJobLeaseDurationMs = 180_000;

export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';

  constructor(jobKey: string) {
    super(`lease lost for durable job ${jobKey}`);
    this.name = 'LeaseLostError';
  }
}

export class JobRepository {
  readonly leaseDurationMs: number;

  constructor(
    readonly client: Database.Database,
    options: { leaseDurationMs?: number } = {}
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? defaultJobLeaseDurationMs;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive safe integer');
    }
  }

  enqueueProcessMinute(
    minuteId: string,
    options: EnqueueProcessMinuteOptions = {}
  ): { created: boolean; job: DurableJob } {
    const job: DurableJob = {
      kind: 'process_minute',
      key: `minute:${minuteId}`,
      minuteId,
      subscriberOpenIds: normalizeOpenIds(options.subscriberOpenIds),
      attemptsByCode: zeroRetryAttempts()
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
      serializeJobPayload(job),
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

    return rows.flatMap((row) => {
      const payload = normalizeProcessMinuteJobPayload(row.payload);
      return payload ? [{
        kind: row.type,
        key: row.stable_key,
        minuteId: payload.minuteId,
        subscriberOpenIds: payload.subscriberOpenIds,
        attemptsByCode: payload.attemptsByCode
      }] : [];
    });
  }

  leaseNextProcessMinute(availableAt: Date): DurableJob | null {
    const leaseUntil = new Date(availableAt.getTime() + this.leaseDurationMs);
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

      const payload = normalizeProcessMinuteJobPayload(row.payload);
      if (!payload) {
        this.client.prepare(`
          UPDATE batch_jobs
          SET status = 'failed', payload = ?
          WHERE stable_key = ? AND status IN ('queued', 'retry', 'processing')
        `).run(JSON.stringify({ failureReason: 'JOB_PAYLOAD_INVALID' }), row.stable_key);
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

      return {
        kind: row.type,
        key: row.stable_key,
        minuteId: payload.minuteId,
        subscriberOpenIds: payload.subscriberOpenIds,
        attemptsByCode: payload.attemptsByCode,
        leaseExpiresAt: leaseUntil.toISOString()
      };
    })();
  }

  markCompleted(job: DurableJob, completedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    const result = this.client.prepare(`
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
    assertLeaseMutation(result.changes, job.key);
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

  markRetry(
    job: DurableJob,
    retryCode: RetryErrorCode,
    availableAt: Date,
    attemptedAt: Date
  ): void {
    const leaseExpiresAt = requireLease(job);
    const attemptsByCode = incrementRetryAttempt(job.attemptsByCode, retryCode);
    const result = this.client.prepare(`
      UPDATE batch_jobs
      SET status = 'retry', payload = ?, updated_at = ?
      WHERE stable_key = ?
        AND status = 'processing'
        AND updated_at = ?
        AND updated_at > ?
    `).run(
      serializeJobPayload(job, attemptsByCode),
      availableAt.toISOString(),
      job.key,
      leaseExpiresAt,
      attemptedAt.toISOString()
    );
    assertLeaseMutation(result.changes, job.key);
  }

  markFailed(
    job: DurableJob,
    failureReason: string,
    failedAt: Date,
    retryCode?: RetryErrorCode
  ): void {
    const leaseExpiresAt = requireLease(job);
    const attemptsByCode = retryCode
      ? incrementRetryAttempt(job.attemptsByCode, retryCode)
      : job.attemptsByCode;
    const result = this.client.prepare(`
      UPDATE batch_jobs
      SET status = 'failed', payload = ?, updated_at = ?
      WHERE stable_key = ?
        AND status = 'processing'
        AND updated_at = ?
        AND updated_at > ?
    `).run(
      serializeJobPayload(job, attemptsByCode, failureReason),
      failedAt.toISOString(),
      job.key,
      leaseExpiresAt,
      failedAt.toISOString()
    );
    assertLeaseMutation(result.changes, job.key);
  }
}

interface JobRow {
  type: DurableJob['kind'];
  stable_key: string;
  payload: string;
}

function requireLease(job: DurableJob): string {
  if (!job.leaseExpiresAt) {
    throw new Error('job must be leased before its status can change');
  }
  return job.leaseExpiresAt;
}

export function normalizeProcessMinuteJobPayload(
  payload: string
): ProcessMinuteJobPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.minuteId !== 'string' || !parsed.minuteId.trim()) {
    return null;
  }

  let attemptsByCode: RetryAttemptsByCode;
  if ('attemptsByCode' in parsed) {
    if (!isRetryAttemptsByCode(parsed.attemptsByCode)) {
      return null;
    }
    attemptsByCode = parsed.attemptsByCode;
  } else if ('attempt' in parsed) {
    if (!isRetryAttempt(parsed.attempt)) {
      return null;
    }
    attemptsByCode = {
      MINUTE_NOT_READY: parsed.attempt,
      RATE_LIMITED: parsed.attempt
    };
  } else {
    attemptsByCode = zeroRetryAttempts();
  }

  return {
    minuteId: parsed.minuteId.trim(),
    subscriberOpenIds: isStringArray(parsed.subscriberOpenIds)
      ? normalizeOpenIds(parsed.subscriberOpenIds)
      : [],
    attemptsByCode,
    ...(typeof parsed.failureReason === 'string'
      ? { failureReason: parsed.failureReason }
      : {})
  };
}

function serializeJobPayload(
  job: Pick<DurableJob, 'minuteId' | 'attemptsByCode'> & Partial<Pick<DurableJob, 'subscriberOpenIds'>>,
  attemptsByCode: RetryAttemptsByCode = job.attemptsByCode,
  failureReason?: string
): string {
  const subscriberOpenIds = normalizeOpenIds(job.subscriberOpenIds);
  return JSON.stringify({
    minuteId: job.minuteId,
    ...(subscriberOpenIds.length > 0 ? { subscriberOpenIds } : {}),
    attemptsByCode,
    ...(failureReason ? { failureReason } : {})
  });
}

function incrementRetryAttempt(
  attempts: RetryAttemptsByCode,
  retryCode: RetryErrorCode
): RetryAttemptsByCode {
  return {
    ...attempts,
    [retryCode]: Math.min(attempts[retryCode] + 1, Number.MAX_SAFE_INTEGER)
  };
}

function isRetryAttemptsByCode(value: unknown): value is RetryAttemptsByCode {
  return isRecord(value) &&
    isRetryAttempt(value.MINUTE_NOT_READY) &&
    isRetryAttempt(value.RATE_LIMITED);
}

function isRetryAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeOpenIds(openIds: readonly string[] | undefined): string[] {
  return [...new Set((openIds ?? [])
    .map((openId) => openId.trim())
    .filter((openId) => openId.startsWith('ou_')))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertLeaseMutation(changes: number, jobKey: string): void {
  if (changes !== 1) {
    throw new LeaseLostError(jobKey);
  }
}
