import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { ingestMinuteGenerated } from '../src/services/minute-ingestion.js';

const minuteGeneratedFixture = JSON.parse(
  readFileSync(new URL('../src/fixtures/minute-generated.json', import.meta.url), 'utf8')
) as unknown;

describe('ingestMinuteGenerated', () => {
  it('creates one durable job for a new minute', () => {
    const result = ingestFixtureTwice({ times: 1 });

    expect(result.jobs).toEqual([{ kind: 'process_minute', key: 'minute:min_fixture_1' }]);
    expect(result.statuses).toEqual(['accepted']);
  });

  it('does not duplicate work when Feishu retries the event', () => {
    const result = ingestFixtureTwice({ times: 2 });

    expect(result.minuteCount).toBe(1);
    expect(result.jobCount).toBe(1);
    expect(result.statuses).toEqual(['accepted', 'duplicate']);
  });

  it('ignores unsupported event types', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);

    expect(ingestMinuteGenerated(
      { header: { event_type: 'vc.meeting.recording_ready_v1' } },
      {
        meetingRepository: new MeetingRepository(database.client),
        jobRepository: new JobRepository(database.client)
      }
    ).status).toBe('ignored');
  });

  it('persists subscriber open IDs on the durable minute job', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const jobRepository = new JobRepository(database.client);

    const result = ingestMinuteGenerated({
      schema: '2.0',
      header: {
        event_id: 'evt_subscriber_1',
        event_type: 'minutes.minute.generated_v1',
        create_time: '1785396472290'
      },
      event: {
        minute_token: 'obcn4354ahqx4bbin5qqq8t2',
        subscriber_ids: [
          { open_id: 'ou_ivy_fixture' },
          { union_id: 'on_missing_open_id' }
        ]
      }
    }, {
      meetingRepository: new MeetingRepository(database.client),
      jobRepository
    });

    expect(result.status).toBe('accepted');
    expect(jobRepository.list()).toMatchObject([{
      kind: 'process_minute',
      key: 'minute:obcn4354ahqx4bbin5qqq8t2',
      subscriberOpenIds: ['ou_ivy_fixture']
    }]);
  });
});

function ingestFixtureTwice({ times }: { times: number }) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const jobRepository = new JobRepository(database.client);
  const dependencies = {
    meetingRepository: new MeetingRepository(database.client),
    jobRepository
  };
  const statuses = Array.from({ length: times }, () =>
    ingestMinuteGenerated(minuteGeneratedFixture, dependencies).status
  );

  return {
    statuses,
    minuteCount: countRows(database.client, 'meeting_minutes'),
    jobCount: countRows(database.client, 'batch_jobs'),
    jobs: jobRepository.list().map((job) => ({ kind: job.kind, key: job.key }))
  };
}

function countRows(client: Database.Database, table: string): number {
  const row = client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}
