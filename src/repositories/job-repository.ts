import type Database from 'better-sqlite3';
import { canonicalJson, sha256 } from '../services/canonical-json.js';

export interface ProcessMinuteJob {
  kind: 'process_minute';
  key: string;
  minuteId: string;
  subscriberOpenIds?: string[];
  attemptsByCode: RetryAttemptsByCode;
  leaseExpiresAt?: string;
}

export interface ExtractContextCandidatesJob {
  kind: 'extract_context_candidates';
  key: string;
  sourceId: string;
  extractionKey: string;
  attempt: number;
  leaseExpiresAt?: string;
}

export type DurableJob = ProcessMinuteJob | ExtractContextCandidatesJob;

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
  contextFailureCode?: string;
}

export interface EnqueueProcessMinuteOptions {
  subscriberOpenIds?: string[];
}

export interface ExtractContextCandidatesJobPayload {
  sourceId: string;
  extractionKey: string;
  attempt: number;
  failureReason?: string;
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
  ): { created: boolean; job: ProcessMinuteJob } {
    const job: ProcessMinuteJob = {
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

  enqueueContextExtraction(input: {
    sourceId: string;
    extractorVersion: string;
    promptVersion: string;
  }): { created: boolean; job: ExtractContextCandidatesJob } {
    const extractionKey = `${input.extractorVersion}:${input.promptVersion}`;
    const key = `context-extract:${input.sourceId}:${input.extractorVersion}:${input.promptVersion}`;
    const job: ExtractContextCandidatesJob = {
      kind: 'extract_context_candidates', key, sourceId: input.sourceId,
      extractionKey, attempt: 0
    };
    const now = new Date().toISOString();
    const result = this.client.prepare(`
      INSERT INTO batch_jobs (id, type, stable_key, payload, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(stable_key) DO NOTHING
    `).run(key, job.kind, key, serializeContextJobPayload(job), now, now);
    return { created: result.changes === 1, job };
  }

  list(): DurableJob[] {
    const rows = this.client.prepare(`
      SELECT type, stable_key, payload
      FROM batch_jobs
      ORDER BY created_at ASC
    `).all() as JobRow[];

    return rows.flatMap((row) => {
      const job = normalizeJobRow(row);
      return job ? [job] : [];
    });
  }

  /** Queued for the founder-stream consumer only; existing workers do not lease this kind. */
  enqueueFounderStreamBatch(input: {
    chatId: string; since: string; until: string; sourceIds: readonly string[]; capturedAt: Date;
  }): { created: boolean; key: string } {
    const sourceIds = [...new Set(input.sourceIds)].sort();
    if (sourceIds.length === 0) throw new Error('founder stream batch requires sources');
    const payload = { chatId: input.chatId, since: input.since, until: input.until, sourceIds };
    const key = `founder-stream-batch:${sha256(canonicalJson({ chatId: input.chatId, sourceIds }))}`;
    const timestamp = input.capturedAt.toISOString();
    const result = this.client.prepare(`
      INSERT INTO batch_jobs (id, type, stable_key, payload, status, created_at, updated_at)
      VALUES (?, 'analyze_founder_stream_batch', ?, ?, 'queued', ?, ?)
      ON CONFLICT(stable_key) DO NOTHING
    `).run(key, key, JSON.stringify(payload), timestamp, timestamp);
    return { created: result.changes === 1, key };
  }

  leaseNextProcessMinute(availableAt: Date): ProcessMinuteJob | null {
    const job = this.leaseNextSupportedJob(availableAt, ['process_minute']);
    return job?.kind === 'process_minute' ? job : null;
  }

  leaseNextSupportedJob(
    availableAt: Date,
    supportedKinds: readonly DurableJob['kind'][] = ['process_minute', 'extract_context_candidates']
  ): DurableJob | null {
    const kinds = [...new Set(supportedKinds)];
    if (kinds.length === 0) return null;
    if (kinds.some((kind) => kind !== 'process_minute' && kind !== 'extract_context_candidates')) {
      throw new Error('unsupported durable job kind');
    }
    const leaseUntil = new Date(availableAt.getTime() + this.leaseDurationMs);
    return this.client.transaction(() => {
      const placeholders = kinds.map(() => '?').join(', ');
      const row = this.client.prepare(`
        SELECT type, stable_key, payload
        FROM batch_jobs
        WHERE type IN (${placeholders})
          AND status IN ('queued', 'retry', 'processing')
          AND updated_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(...kinds, availableAt.toISOString()) as JobRow | undefined;
      if (!row) {
        return null;
      }

      const job = normalizeJobRow(row);
      if (!job) {
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
        ...job,
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
    job: ProcessMinuteJob,
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
    job: ProcessMinuteJob,
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

  recordContextFailure(job: ProcessMinuteJob, failureCode: string, recordedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    const result = this.client.prepare(`
      UPDATE batch_jobs SET payload = ?
      WHERE stable_key = ? AND status = 'processing' AND updated_at = ? AND updated_at > ?
    `).run(serializeJobPayload(job, job.attemptsByCode, undefined, failureCode),
      job.key, leaseExpiresAt, recordedAt.toISOString());
    assertLeaseMutation(result.changes, job.key);
  }

  markContextRetry(job: ExtractContextCandidatesJob, availableAt: Date, attemptedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    const nextAttempt = Math.min(job.attempt + 1, Number.MAX_SAFE_INTEGER);
    const result = this.client.prepare(`
      UPDATE batch_jobs SET status = 'retry', payload = ?, updated_at = ?
      WHERE stable_key = ? AND status = 'processing' AND updated_at = ? AND updated_at > ?
    `).run(serializeContextJobPayload(job, nextAttempt), availableAt.toISOString(),
      job.key, leaseExpiresAt, attemptedAt.toISOString());
    assertLeaseMutation(result.changes, job.key);
  }

  markContextFailed(job: ExtractContextCandidatesJob, failureReason: string, failedAt: Date): void {
    const leaseExpiresAt = requireLease(job);
    const result = this.client.prepare(`
      UPDATE batch_jobs SET status = 'failed', payload = ?, updated_at = ?
      WHERE stable_key = ? AND status = 'processing' AND updated_at = ? AND updated_at > ?
    `).run(serializeContextJobPayload(job, job.attempt, failureReason), failedAt.toISOString(),
      job.key, leaseExpiresAt, failedAt.toISOString());
    assertLeaseMutation(result.changes, job.key);
  }
}

interface JobRow {
  type: string;
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
      : {}),
    ...(typeof parsed.contextFailureCode === 'string'
      ? { contextFailureCode: parsed.contextFailureCode }
      : {})
  };
}

function serializeJobPayload(
  job: Pick<ProcessMinuteJob, 'minuteId' | 'attemptsByCode'> & Partial<Pick<ProcessMinuteJob, 'subscriberOpenIds'>>,
  attemptsByCode: RetryAttemptsByCode = job.attemptsByCode,
  failureReason?: string,
  contextFailureCode?: string
): string {
  const subscriberOpenIds = normalizeOpenIds(job.subscriberOpenIds);
  return JSON.stringify({
    minuteId: job.minuteId,
    ...(subscriberOpenIds.length > 0 ? { subscriberOpenIds } : {}),
    attemptsByCode,
    ...(failureReason ? { failureReason } : {}),
    ...(contextFailureCode ? { contextFailureCode } : {})
  });
}

export function normalizeContextJobPayload(payload: string): ExtractContextCandidatesJobPayload | null {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!isRecord(parsed) || typeof parsed.sourceId !== 'string' || !parsed.sourceId.trim() ||
    typeof parsed.extractionKey !== 'string' || !parsed.extractionKey.trim() ||
    !isRetryAttempt(parsed.attempt)) return null;
  return { sourceId: parsed.sourceId.trim(), extractionKey: parsed.extractionKey.trim(),
    attempt: parsed.attempt, ...(typeof parsed.failureReason === 'string' ? { failureReason: parsed.failureReason } : {}) };
}

function serializeContextJobPayload(
  job: Pick<ExtractContextCandidatesJob, 'sourceId' | 'extractionKey' | 'attempt'>,
  attempt = job.attempt,
  failureReason?: string
): string {
  return JSON.stringify({ sourceId: job.sourceId, extractionKey: job.extractionKey, attempt,
    ...(failureReason ? { failureReason } : {}) });
}

function normalizeJobRow(row: JobRow): DurableJob | null {
  if (row.type === 'process_minute') {
    const payload = normalizeProcessMinuteJobPayload(row.payload);
    return payload ? { kind: 'process_minute', key: row.stable_key,
      minuteId: payload.minuteId, subscriberOpenIds: payload.subscriberOpenIds,
      attemptsByCode: payload.attemptsByCode } : null;
  }
  if (row.type === 'extract_context_candidates') {
    const payload = normalizeContextJobPayload(row.payload);
    return payload ? { kind: 'extract_context_candidates', key: row.stable_key,
      sourceId: payload.sourceId, extractionKey: payload.extractionKey, attempt: payload.attempt } : null;
  }
  return null;
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
