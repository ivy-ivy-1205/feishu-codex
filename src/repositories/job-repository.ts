import type Database from 'better-sqlite3';

export interface DurableJob {
  kind: 'process_minute';
  key: string;
  minuteId: string;
}

export class JobRepository {
  constructor(readonly client: Database.Database) {}

  enqueueProcessMinute(minuteId: string): { created: boolean; job: DurableJob } {
    const job: DurableJob = {
      kind: 'process_minute',
      key: `minute:${minuteId}`,
      minuteId
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
      minuteId: JSON.parse(row.payload).minuteId
    }));
  }
}

interface JobRow {
  type: DurableJob['kind'];
  stable_key: string;
  payload: string;
}
