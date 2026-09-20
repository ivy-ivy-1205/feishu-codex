import type Database from 'better-sqlite3';
import {
  normalizeProcessMinuteJobPayload
} from '../repositories/job-repository.js';

const migrationSql = `
  CREATE TABLE IF NOT EXISTS feishu_events (
    event_id TEXT PRIMARY KEY,
    minute_id TEXT NOT NULL,
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_minutes (
    minute_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES feishu_events(event_id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_summaries (
    id TEXT PRIMARY KEY,
    minute_id TEXT NOT NULL REFERENCES meeting_minutes(minute_id),
    summary_message_id TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS meeting_summaries_minute_id_unique
    ON meeting_summaries(minute_id);

  CREATE TABLE IF NOT EXISTS meeting_todos (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES meeting_summaries(id),
    displayed_number INTEGER NOT NULL CONSTRAINT meeting_todos_displayed_number_positive CHECK(displayed_number > 0),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    risk TEXT NOT NULL CONSTRAINT meeting_todos_risk_allowed CHECK(risk IN ('low', 'high')),
    capability TEXT NOT NULL DEFAULT 'unknown' CONSTRAINT meeting_todos_capability_allowed CHECK(capability IN ('unknown', 'content_draft', 'code_write', 'external_message', 'deploy', 'delete', 'production_access')),
    status TEXT NOT NULL DEFAULT 'proposed' CONSTRAINT meeting_todos_status_allowed CHECK(status IN ('proposed', 'authorized', 'running', 'completed', 'failed', 'needs_confirmation')),
    created_at TEXT NOT NULL,
    UNIQUE(summary_id, displayed_number)
  );

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    stable_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS batch_jobs_stable_key_unique
    ON batch_jobs(stable_key);

  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    destination TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    delivered_message_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error_code TEXT
  );

  CREATE TABLE IF NOT EXISTS approval_actions (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL REFERENCES meeting_todos(id),
    approver_open_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    project_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    local_path_hint TEXT,
    repo_url TEXT,
    default_branch TEXT,
    status TEXT NOT NULL CONSTRAINT projects_status_allowed CHECK(status IN ('active', 'archived')),
    origin TEXT NOT NULL DEFAULT 'legacy_seed'
      CONSTRAINT projects_origin_allowed
      CHECK(origin IN ('discovered', 'human_confirmed', 'legacy_seed')),
    stage TEXT NOT NULL DEFAULT 'active_project'
      CONSTRAINT projects_stage_allowed
      CHECK(stage IN ('idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_mapping_rules (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    pattern_kind TEXT NOT NULL CONSTRAINT project_mapping_rules_pattern_kind_allowed CHECK(pattern_kind IN ('keyword', 'exact', 'regex')),
    project_key TEXT NOT NULL REFERENCES projects(project_key),
    subproject_key TEXT,
    confidence_hint TEXT NOT NULL CONSTRAINT project_mapping_rules_confidence_allowed CHECK(confidence_hint IN ('high', 'medium', 'low')),
    priority INTEGER NOT NULL,
    source TEXT NOT NULL CONSTRAINT project_mapping_rules_source_allowed CHECK(source IN ('system', 'ivy_correction')),
    active INTEGER NOT NULL CONSTRAINT project_mapping_rules_active_allowed CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_context_snapshots (
    id TEXT PRIMARY KEY,
    project_key TEXT REFERENCES projects(project_key),
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    content TEXT NOT NULL,
    digest TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_mapping_conflicts (
    id TEXT PRIMARY KEY,
    todo_id TEXT REFERENCES meeting_todos(id),
    candidate_project_key TEXT,
    existing_project_key TEXT,
    evidence TEXT NOT NULL,
    status TEXT NOT NULL CONSTRAINT project_mapping_conflicts_status_allowed CHECK(status IN ('open', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS feishu_user_oauth_tokens (
    open_id TEXT PRIMARY KEY,
    user_access_token_ciphertext TEXT NOT NULL,
    refresh_token_ciphertext TEXT NOT NULL,
    access_token_expires_at TEXT NOT NULL,
    refresh_token_expires_at TEXT NOT NULL,
    authorization_status TEXT NOT NULL
      CONSTRAINT feishu_user_oauth_tokens_authorization_status_allowed
      CHECK(authorization_status IN ('valid', 'invalid')),
    subscription_status TEXT NOT NULL,
    last_event_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_sources (
    id TEXT PRIMARY KEY,
    source_system TEXT NOT NULL,
    source_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    logical_key TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK(source_version > 0),
    occurred_at TEXT NOT NULL,
    authors_json TEXT NOT NULL,
    locator_uri TEXT,
    content_format TEXT NOT NULL,
    content_text TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    availability_status TEXT NOT NULL CHECK(availability_status IN ('available', 'deleted', 'permission_lost', 'unknown')),
    captured_at TEXT NOT NULL,
    UNIQUE(logical_key, content_hash),
    UNIQUE(logical_key, source_version)
  );

  CREATE TABLE IF NOT EXISTS context_source_relations (
    from_source_id TEXT NOT NULL REFERENCES context_sources(id),
    to_source_id TEXT NOT NULL REFERENCES context_sources(id),
    relation_type TEXT NOT NULL CHECK(relation_type IN ('derived_from', 'part_of', 'revises')),
    created_at TEXT NOT NULL,
    CHECK(from_source_id <> to_source_id),
    UNIQUE(from_source_id, to_source_id, relation_type)
  );

  CREATE TABLE IF NOT EXISTS context_evidence (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES context_sources(id),
    source_version INTEGER NOT NULL CHECK(source_version > 0),
    excerpt TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    excerpt_hash TEXT NOT NULL,
    evidence_level TEXT NOT NULL CHECK(evidence_level IN ('derived_summary', 'primary_statement', 'authoritative_record', 'direct_observation')),
    captured_at TEXT NOT NULL,
    UNIQUE(source_id, excerpt_hash, locator_json)
  );

  CREATE TABLE IF NOT EXISTS context_topics (
    id TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL
      CONSTRAINT context_topics_current_version_positive CHECK(current_version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_topic_versions (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES context_topics(id),
    version_number INTEGER NOT NULL
      CONSTRAINT context_topic_versions_number_positive CHECK(version_number > 0),
    display_name TEXT NOT NULL,
    stage TEXT NOT NULL
      CONSTRAINT context_topic_versions_stage_allowed
      CHECK(stage IN ('idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed')),
    outcome TEXT,
    rationale TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    UNIQUE(topic_id, version_number)
  );

  CREATE TABLE IF NOT EXISTS context_topic_sources (
    id TEXT PRIMARY KEY,
    topic_version_id TEXT NOT NULL REFERENCES context_topic_versions(id),
    source_id TEXT NOT NULL REFERENCES context_sources(id),
    evidence_id TEXT REFERENCES context_evidence(id),
    added_at TEXT NOT NULL,
    UNIQUE(topic_version_id, source_id, evidence_id)
  );

  CREATE TABLE IF NOT EXISTS context_topic_relations (
    id TEXT PRIMARY KEY,
    from_topic_id TEXT NOT NULL REFERENCES context_topics(id),
    from_topic_version_id TEXT NOT NULL REFERENCES context_topic_versions(id),
    to_topic_id TEXT NOT NULL REFERENCES context_topics(id),
    to_topic_version_id TEXT NOT NULL REFERENCES context_topic_versions(id),
    relation_type TEXT NOT NULL
      CONSTRAINT context_topic_relations_type_allowed
      CHECK(relation_type IN ('same_as', 'split_from', 'part_of', 'related_to', 'supersedes')),
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT context_topic_relations_distinct_topics CHECK(from_topic_id <> to_topic_id),
    UNIQUE(from_topic_id, to_topic_id, relation_type)
  );

  CREATE TABLE IF NOT EXISTS founder_identities (
    id TEXT PRIMARY KEY,
    founder TEXT NOT NULL
      CONSTRAINT founder_identities_founder_allowed
      CHECK(founder IN ('ivy', 'james')),
    source_system TEXT NOT NULL,
    external_author_id TEXT NOT NULL,
    configured_at TEXT NOT NULL,
    UNIQUE(source_system, external_author_id)
  );

  CREATE TABLE IF NOT EXISTS topic_perspectives (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES context_topics(id),
    kind TEXT NOT NULL
      CONSTRAINT topic_perspectives_kind_allowed
      CHECK(kind IN ('ivy_view', 'james_view', 'shared_decision', 'unresolved')),
    current_version INTEGER NOT NULL
      CONSTRAINT topic_perspectives_current_version_positive CHECK(current_version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(topic_id, kind)
  );

  CREATE TABLE IF NOT EXISTS topic_perspective_versions (
    id TEXT PRIMARY KEY,
    perspective_id TEXT NOT NULL REFERENCES topic_perspectives(id),
    version_number INTEGER NOT NULL
      CONSTRAINT topic_perspective_versions_number_positive CHECK(version_number > 0),
    statement TEXT NOT NULL,
    confidence REAL NOT NULL
      CONSTRAINT topic_perspective_versions_confidence_range CHECK(confidence >= 0 AND confidence <= 1),
    evidence_ids_json TEXT NOT NULL,
    decision_key TEXT,
    speech_act TEXT NOT NULL
      CONSTRAINT topic_perspective_versions_speech_act_allowed
      CHECK(speech_act IN ('view', 'decision_proposal', 'explicit_agreement', 'explicit_disagreement')),
    observed_at TEXT NOT NULL,
    UNIQUE(perspective_id, version_number)
  );

  CREATE TABLE IF NOT EXISTS context_extraction_runs (
    id TEXT PRIMARY KEY,
    source_set_hash TEXT NOT NULL,
    extractor_name TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
    error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(source_set_hash, extractor_name, extractor_version, prompt_version)
  );

  CREATE TABLE IF NOT EXISTS context_extraction_run_sources (
    extraction_run_id TEXT NOT NULL REFERENCES context_extraction_runs(id),
    source_id TEXT NOT NULL REFERENCES context_sources(id),
    source_role TEXT NOT NULL CHECK(source_role IN ('primary', 'context')),
    UNIQUE(extraction_run_id, source_id)
  );

  CREATE TABLE IF NOT EXISTS context_candidates (
    id TEXT PRIMARY KEY,
    extraction_run_id TEXT NOT NULL REFERENCES context_extraction_runs(id),
    candidate_type TEXT NOT NULL CHECK(candidate_type IN ('proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker', 'requirement', 'status_update', 'action_item')),
    scope TEXT NOT NULL CHECK(scope IN ('company', 'project')),
    summary TEXT NOT NULL,
    subject_key TEXT,
    structured_payload TEXT NOT NULL,
    extraction_confidence REAL NOT NULL CHECK(extraction_confidence >= 0 AND extraction_confidence <= 1),
    factual_status TEXT NOT NULL CHECK(factual_status IN ('source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed')),
    review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'approved', 'rejected', 'needs_clarification', 'conflict')),
    candidate_fingerprint TEXT NOT NULL UNIQUE,
    external_refs_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_candidate_projects (
    candidate_id TEXT NOT NULL REFERENCES context_candidates(id),
    project_key TEXT REFERENCES projects(project_key),
    project_role TEXT NOT NULL CHECK(project_role IN ('primary', 'related')),
    mapping_status TEXT NOT NULL CHECK(mapping_status IN ('mapped', 'needs_confirmation', 'unmapped', 'conflict')),
    mapping_confidence TEXT NOT NULL CHECK(mapping_confidence IN ('high', 'medium', 'low')),
    mapping_evidence TEXT NOT NULL,
    UNIQUE(candidate_id, project_key, project_role)
  );

  CREATE TABLE IF NOT EXISTS context_candidate_evidence (
    candidate_id TEXT NOT NULL REFERENCES context_candidates(id),
    evidence_id TEXT NOT NULL REFERENCES context_evidence(id),
    evidence_role TEXT NOT NULL CHECK(evidence_role IN ('supporting', 'contradicting', 'context')),
    UNIQUE(candidate_id, evidence_id, evidence_role)
  );

  CREATE TABLE IF NOT EXISTS context_records (
    id TEXT PRIMARY KEY,
    record_type TEXT NOT NULL CHECK(record_type IN ('proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker', 'requirement', 'status_update', 'action_item')),
    scope TEXT NOT NULL CHECK(scope IN ('company', 'project')),
    subject_key TEXT,
    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active', 'disputed', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_record_versions (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES context_records(id),
    version_number INTEGER NOT NULL CHECK(version_number > 0),
    summary TEXT NOT NULL,
    structured_payload TEXT NOT NULL,
    factual_status TEXT NOT NULL CHECK(factual_status IN ('source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed')),
    source_candidate_id TEXT NOT NULL REFERENCES context_candidates(id),
    reviewer_open_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(record_id, version_number)
  );

  CREATE TABLE IF NOT EXISTS context_candidate_record_relations (
    candidate_id TEXT NOT NULL REFERENCES context_candidates(id),
    record_id TEXT NOT NULL REFERENCES context_records(id),
    relation_type TEXT NOT NULL CHECK(relation_type IN ('supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates')),
    status TEXT NOT NULL CHECK(status IN ('suggested', 'confirmed', 'rejected')),
    rationale TEXT NOT NULL,
    UNIQUE(candidate_id, record_id, relation_type)
  );

  CREATE TABLE IF NOT EXISTS context_reviews (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES context_candidates(id),
    action TEXT NOT NULL CHECK(action IN ('approve', 'reject', 'request_clarification', 'mark_conflict')),
    reviewer_open_id TEXT NOT NULL,
    approved_summary TEXT,
    approved_payload TEXT,
    decided_factual_status TEXT CHECK(decided_factual_status IN ('source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed')),
    target_record_id TEXT REFERENCES context_records(id),
    relation_type TEXT CHECK(relation_type IN ('supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates')),
    reason TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_record_projects (
    record_version_id TEXT NOT NULL REFERENCES context_record_versions(id),
    project_key TEXT NOT NULL REFERENCES projects(project_key),
    project_role TEXT NOT NULL CHECK(project_role IN ('primary', 'related')),
    UNIQUE(record_version_id, project_key, project_role)
  );

  CREATE TABLE IF NOT EXISTS context_record_evidence (
    record_version_id TEXT NOT NULL REFERENCES context_record_versions(id),
    evidence_id TEXT NOT NULL REFERENCES context_evidence(id),
    evidence_role TEXT NOT NULL CHECK(evidence_role IN ('supporting', 'contradicting', 'context')),
    UNIQUE(record_version_id, evidence_id, evidence_role)
  );

  CREATE TABLE IF NOT EXISTS context_record_relations (
    id TEXT PRIMARY KEY,
    from_record_version_id TEXT NOT NULL REFERENCES context_record_versions(id),
    to_record_version_id TEXT NOT NULL REFERENCES context_record_versions(id),
    relation_type TEXT NOT NULL CHECK(relation_type IN ('supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates')),
    review_id TEXT NOT NULL REFERENCES context_reviews(id),
    created_at TEXT NOT NULL,
    CHECK(from_record_version_id <> to_record_version_id),
    UNIQUE(from_record_version_id, to_record_version_id, relation_type)
  );
`;

export function migrateDatabase(client: Database.Database): void {
  migrateLegacyBatchJobs(client);
  client.exec(migrationSql);
  migrateProcessMinuteRetryPayloads(client);
  migrateOutboxDeliveryColumn(client);
  migrateOutboxMessageIdColumn(client);
  migrateContextOutboxRetryColumns(client);
  client.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS outbox_delivered_message_id_unique
      ON outbox(delivered_message_id)
      WHERE delivered_message_id IS NOT NULL
  `);
  migrateTodoCapabilityColumn(client);
  migrateTodoProjectColumns(client);
  migrateProjectAuthorityColumns(client);
}

function migrateProcessMinuteRetryPayloads(client: Database.Database): void {
  const rows = client.prepare(`
    SELECT stable_key, payload, status
    FROM batch_jobs
    WHERE type = 'process_minute'
  `).all() as Array<{ stable_key: string; payload: string; status: string }>;
  const update = client.prepare(`
    UPDATE batch_jobs SET status = ?, payload = ? WHERE stable_key = ?
  `);

  client.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeProcessMinuteJobPayload(row.payload);
      if (!normalized) {
        update.run(
          'failed',
          JSON.stringify({ failureReason: 'JOB_PAYLOAD_INVALID' }),
          row.stable_key
        );
        continue;
      }
      update.run(row.status, JSON.stringify(normalized), row.stable_key);
    }
  })();
}

function migrateTodoCapabilityColumn(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(meeting_todos)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'capability')) {
    return;
  }
  client.exec(`
    ALTER TABLE meeting_todos
    ADD COLUMN capability TEXT NOT NULL DEFAULT 'unknown'
      CONSTRAINT meeting_todos_capability_allowed
      CHECK(capability IN ('unknown', 'content_draft', 'code_write', 'external_message', 'deploy', 'delete', 'production_access'))
  `);
}

function migrateTodoProjectColumns(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(meeting_todos)').all() as TableColumn[];
  const additions = [
    ['project_key', 'TEXT DEFAULT NULL'],
    ['subproject_key', 'TEXT DEFAULT NULL'],
    ['project_confidence', "TEXT NOT NULL DEFAULT 'low'"],
    ['project_evidence', "TEXT NOT NULL DEFAULT ''"],
    ['project_mapping_status', "TEXT NOT NULL DEFAULT 'unmapped'"],
    ['project_prompt', "TEXT NOT NULL DEFAULT ''"]
  ] as const;

  for (const [name, definition] of additions) {
    if (!columns.some((column) => column.name === name)) {
      client.exec(`ALTER TABLE meeting_todos ADD COLUMN ${name} ${definition}`);
    }
  }
}

function migrateProjectAuthorityColumns(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(projects)').all() as TableColumn[];
  if (!columns.some((column) => column.name === 'origin')) {
    client.exec(`
      ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy_seed'
        CONSTRAINT projects_origin_allowed
        CHECK(origin IN ('discovered', 'human_confirmed', 'legacy_seed'))
    `);
  }
  if (!columns.some((column) => column.name === 'stage')) {
    client.exec(`
      ALTER TABLE projects ADD COLUMN stage TEXT NOT NULL DEFAULT 'active_project'
        CONSTRAINT projects_stage_allowed
        CHECK(stage IN ('idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed'))
    `);
  }
}

function migrateOutboxDeliveryColumn(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(outbox)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'delivered_at')) {
    return;
  }
  client.exec('ALTER TABLE outbox ADD COLUMN delivered_at TEXT');
}

function migrateOutboxMessageIdColumn(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(outbox)').all() as TableColumn[];
  if (!columns.some((column) => column.name === 'delivered_message_id')) {
    client.exec('ALTER TABLE outbox ADD COLUMN delivered_message_id TEXT');
  }
}

function migrateContextOutboxRetryColumns(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(outbox)').all() as TableColumn[];
  const additions = [
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_attempt_at', 'TEXT'],
    ['last_error_code', 'TEXT']
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.some((column) => column.name === name)) {
      client.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${definition}`);
    }
  }
}

function migrateLegacyBatchJobs(client: Database.Database): void {
  const table = client.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'batch_jobs'
  `).get();
  if (!table) {
    return;
  }

  const columns = client.prepare('PRAGMA table_info(batch_jobs)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'stable_key')) {
    return;
  }

  client.transaction(() => {
    client.exec(`
      ALTER TABLE batch_jobs RENAME TO batch_jobs_legacy;

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
      )
      SELECT id, type, 'legacy:' || id, payload, status, created_at, updated_at
      FROM batch_jobs_legacy;

      DROP TABLE batch_jobs_legacy;
    `);
  })();
}

interface TableColumn {
  name: string;
}
