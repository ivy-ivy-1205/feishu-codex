import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';

describe('migrateDatabase', () => {
  it('upgrades legacy batch jobs without losing their data', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO batch_jobs (id, type, payload, status, created_at, updated_at)
      VALUES ('job_legacy_1', 'process_minute', '{"minuteId":"min_legacy_1"}', 'queued',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
    `);

    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT id, type, payload, status, stable_key, created_at, updated_at
      FROM batch_jobs
    `).get()).toEqual({
      id: 'job_legacy_1',
      type: 'process_minute',
      status: 'queued',
      stable_key: 'legacy:job_legacy_1',
      payload: JSON.stringify({
        minuteId: 'min_legacy_1',
        subscriberOpenIds: [],
        attemptsByCode: {
          MINUTE_NOT_READY: 0,
          RATE_LIMITED: 0
        }
      }),
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    });
    expect(() => database.client.prepare(`
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'job_duplicate_key',
      'process_minute',
      'legacy:job_legacy_1',
      '{}',
      'queued',
      '2026-07-18T00:00:00.000Z',
      '2026-07-18T00:00:00.000Z'
    )).toThrow(/UNIQUE constraint failed/);
  });

  it('migrates a legacy shared attempt conservatively into both retry budgets', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (
        'minute:min_legacy_attempt', 'process_minute', 'minute:min_legacy_attempt',
        '{"minuteId":"min_legacy_attempt","attempt":3}', 'retry',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    const row = database.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = 'minute:min_legacy_attempt'
    `).get() as { status: string; payload: string };
    expect(row.status).toBe('retry');
    expect(JSON.parse(row.payload)).toEqual({
      minuteId: 'min_legacy_attempt',
      subscriberOpenIds: [],
      attemptsByCode: { MINUTE_NOT_READY: 3, RATE_LIMITED: 3 }
    });
  });

  it('fails malformed process-minute payloads closed during migration', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (
        'minute:min_bad_payload', 'process_minute', 'minute:min_bad_payload',
        'not-json', 'queued', '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    const row = database.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = 'minute:min_bad_payload'
    `).get() as { status: string; payload: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload)).toEqual({ failureReason: 'JOB_PAYLOAD_INVALID' });
  });

  it('fails malformed per-code counters closed instead of resetting them', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (
        'minute:min_bad_attempts', 'process_minute', 'minute:min_bad_attempts',
        '{"minuteId":"min_bad_attempts","attemptsByCode":{"MINUTE_NOT_READY":-1,"RATE_LIMITED":0}}',
        'retry', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    const row = database.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = 'minute:min_bad_attempts'
    `).get() as { status: string; payload: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload)).toEqual({ failureReason: 'JOB_PAYLOAD_INVALID' });
  });

  it('adds the outbox delivery timestamp without losing pending messages', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        destination TEXT NOT NULL,
        payload TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      INSERT INTO outbox (id, destination, payload, idempotency_key, status, created_at)
      VALUES ('outbox_legacy_1', 'oc_fixture', '{}', 'legacy-outbox:1', 'pending',
        '2026-07-18T00:00:00.000Z');
    `);

    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT id, status, delivered_at FROM outbox
    `).get()).toEqual({
      id: 'outbox_legacy_1',
      status: 'pending',
      delivered_at: null
    });
  });

  it('backfills legacy Todos to an explicit fail-closed capability', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE meeting_todos (
        id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL,
        displayed_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL,
        UNIQUE(summary_id, displayed_number)
      );

      INSERT INTO meeting_todos (
        id, summary_id, displayed_number, title, description, risk, status, created_at
      ) VALUES (
        'todo_legacy_1', 'summary_legacy_1', 1, '旧任务', '没有能力分类', 'low',
        'proposed', '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT id, capability FROM meeting_todos WHERE id = 'todo_legacy_1'
    `).get()).toEqual({ id: 'todo_legacy_1', capability: 'unknown' });
    expect(() => database.client.prepare(`
      UPDATE meeting_todos SET capability = 'invented_capability'
      WHERE id = 'todo_legacy_1'
    `).run()).toThrow(/CHECK constraint failed/);
  });

  it('adds project mapping columns and registry tables without preset authority', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE meeting_todos (
        id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL,
        displayed_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        risk TEXT NOT NULL,
        capability TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL,
        UNIQUE(summary_id, displayed_number)
      );
      INSERT INTO meeting_todos (
        id, summary_id, displayed_number, title, description, risk, capability, status, created_at
      ) VALUES (
        'todo_legacy_project_1', 'summary_legacy_1', 1, '旧任务', '没有项目映射', 'low',
        'unknown', 'proposed', '2026-07-31T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);
    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT project_key, subproject_key, project_confidence, project_evidence,
        project_mapping_status, project_prompt
      FROM meeting_todos WHERE id = 'todo_legacy_project_1'
    `).get()).toEqual({
      project_key: null,
      subproject_key: null,
      project_confidence: 'low',
      project_evidence: '',
      project_mapping_status: 'unmapped',
      project_prompt: ''
    });
    const projectRepository = new ProjectRepository(database.client);
    expect(projectRepository.listProjects()).toHaveLength(0);
    expect(projectRepository.listMappingRules()).toHaveLength(0);
    expect(database.client.prepare('PRAGMA table_info(projects)').all()
      .map((row) => (row as { name: string }).name))
      .toEqual(expect.arrayContaining(['origin', 'stage']));
    expect(database.client.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'project_context_snapshots', 'project_mapping_conflicts'
      ) ORDER BY name
    `).all()).toEqual([
      { name: 'project_context_snapshots' },
      { name: 'project_mapping_conflicts' }
    ]);
  });

  it('preserves legacy seed rows for audit while excluding them from discovery', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE projects (
        project_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        aliases TEXT NOT NULL,
        local_path_hint TEXT,
        repo_url TEXT,
        default_branch TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_mapping_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        pattern_kind TEXT NOT NULL,
        project_key TEXT NOT NULL REFERENCES projects(project_key),
        subproject_key TEXT,
        confidence_hint TEXT NOT NULL,
        priority INTEGER NOT NULL,
        source TEXT NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects (
        project_key, display_name, aliases, local_path_hint, repo_url,
        default_branch, status, created_at, updated_at
      ) VALUES
        ('feishu-adaptor', 'FeishuAdaptor', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('openmontage', 'OpenMontage', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('aijia-landingpage', 'aijia-landingpage', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('realagent-ai-cc', 'RealAgentAI_cc', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('ljhooker-audiobooks', 'ljhooker-audiobooks', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('ivy-xhs', 'ivy-xhs', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('james-wechat', 'James公众号', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('family-first-ai-os', 'family-first-ai-os', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31'),
        ('aijia-compass-work', 'aijia-compass-work', '[]', NULL, NULL, NULL, 'active', '2026-07-31', '2026-07-31');
      INSERT INTO project_mapping_rules (
        id, pattern, pattern_kind, project_key, subproject_key,
        confidence_hint, priority, source, active, created_at, updated_at
      ) VALUES (
        'system:amy-live', 'Amy Live', 'keyword', 'realagent-ai-cc', 'amy-voice',
        'high', 100, 'system', 0, '2026-07-31', '2026-07-31'
      );
      UPDATE projects SET status='archived' WHERE project_key='openmontage';
      INSERT INTO project_mapping_rules (
        id, pattern, pattern_kind, project_key, subproject_key,
        confidence_hint, priority, source, active, created_at, updated_at
      ) VALUES ('ivy:correction', '已纠正的归属', 'keyword', 'feishu-adaptor', NULL,
        'high', 200, 'ivy_correction', 1, '2026-08-01', '2026-08-02');
    `);

    migrateDatabase(database.client);
    migrateDatabase(database.client);

    const projectRepository = new ProjectRepository(database.client);
    expect(projectRepository.listProjects()).toHaveLength(9);
    expect(projectRepository.getProject('openmontage')).toMatchObject({
      origin: 'legacy_seed',
      stage: 'active_project',
      status: 'archived'
    });
    expect(projectRepository.listMappingRules()).toHaveLength(2);
    expect(projectRepository.listMappingRules()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'system:amy-live', active: false }),
      expect.objectContaining({ id: 'ivy:correction', source: 'ivy_correction', active: true, pattern: '已纠正的归属', projectKey: 'feishu-adaptor' })
    ]));
    expect(database.client.prepare("SELECT created_at, updated_at FROM project_mapping_rules WHERE id='ivy:correction'").get())
      .toEqual({ created_at: '2026-08-01', updated_at: '2026-08-02' });
    expect(projectRepository.listDiscoveryEligibleProjects()).toEqual([]);
  });

  it('creates constrained emergent topic history tables additively', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'context_topic%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'context_topic_relations' },
      { name: 'context_topic_sources' },
      { name: 'context_topic_versions' },
      { name: 'context_topics' }
    ]);
    expect(() => database.client.prepare(`
      INSERT INTO context_topics (id, current_version, created_at, updated_at)
      VALUES ('topic_invalid', 1, '2026-09-01', '2026-09-01')
    `).run()).not.toThrow();
    expect(() => database.client.prepare(`
      INSERT INTO context_topic_versions (
        id, topic_id, version_number, display_name, stage, outcome, rationale,
        evidence_ids_json, changed_at
      ) VALUES ('topicver_invalid', 'topic_invalid', 1, 'Invalid', 'invented_stage',
        NULL, '', '[]', '2026-09-01')
    `).run()).toThrow(/CHECK constraint failed/);
  });

  it('creates aligned constrained founder identity and perspective history tables', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'founder_identities', 'topic_perspectives', 'topic_perspective_versions'
      ) ORDER BY name
    `).all()).toEqual([
      { name: 'founder_identities' },
      { name: 'topic_perspective_versions' },
      { name: 'topic_perspectives' }
    ]);
    expect(() => database.client.prepare(`
      INSERT INTO founder_identities (
        id, founder, source_system, external_author_id, configured_at
      ) VALUES ('founder_bad', 'invented', 'feishu', 'ou_bad', '2026-09-01')
    `).run()).toThrow(/CHECK constraint failed/);
    expect(() => database.client.prepare(`
      INSERT INTO topic_perspectives (
        id, topic_id, kind, current_version, created_at, updated_at
      ) VALUES ('perspective_bad', 'missing_topic', 'consensus', 1, '2026-09-01', '2026-09-01')
    `).run()).toThrow(/CHECK constraint failed/);
  });
});
