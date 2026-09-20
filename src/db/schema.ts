import { sql } from 'drizzle-orm';
import { check, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const feishuEvents = sqliteTable('feishu_events', {
  eventId: text('event_id').primaryKey(),
  minuteId: text('minute_id').notNull(),
  receivedAt: text('received_at').notNull()
});

export const meetingMinutes = sqliteTable('meeting_minutes', {
  minuteId: text('minute_id').primaryKey(),
  eventId: text('event_id').notNull().references(() => feishuEvents.eventId),
  createdAt: text('created_at').notNull()
});

export const meetingSummaries = sqliteTable('meeting_summaries', {
  id: text('id').primaryKey(),
  minuteId: text('minute_id').notNull().references(() => meetingMinutes.minuteId),
  summaryMessageId: text('summary_message_id').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('meeting_summaries_minute_id_unique').on(table.minuteId),
  uniqueIndex('meeting_summaries_summary_message_id_unique').on(table.summaryMessageId)
]);

export const meetingTodos = sqliteTable('meeting_todos', {
  id: text('id').primaryKey(),
  summaryId: text('summary_id').notNull().references(() => meetingSummaries.id),
  displayedNumber: integer('displayed_number').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  risk: text('risk', { enum: ['low', 'high'] }).notNull(),
  capability: text('capability', {
    enum: [
      'unknown',
      'content_draft',
      'code_write',
      'external_message',
      'deploy',
      'delete',
      'production_access'
    ]
  }).notNull().default('unknown'),
  status: text('status', {
    enum: ['proposed', 'authorized', 'running', 'completed', 'failed', 'needs_confirmation']
  }).notNull().default('proposed'),
  projectKey: text('project_key').references(() => projects.projectKey),
  subprojectKey: text('subproject_key'),
  projectConfidence: text('project_confidence', { enum: ['high', 'medium', 'low'] }),
  projectEvidence: text('project_evidence'),
  projectMappingStatus: text('project_mapping_status', {
    enum: ['mapped', 'needs_confirmation', 'unmapped', 'dismissed']
  }),
  projectPrompt: text('project_prompt'),
  createdAt: text('created_at').notNull()
}, (table) => [
  check('meeting_todos_displayed_number_positive', sql`${table.displayedNumber} > 0`),
  check('meeting_todos_risk_allowed', sql`${table.risk} IN ('low', 'high')`),
  check(
    'meeting_todos_capability_allowed',
    sql`${table.capability} IN ('unknown', 'content_draft', 'code_write', 'external_message', 'deploy', 'delete', 'production_access')`
  ),
  check(
    'meeting_todos_status_allowed',
    sql`${table.status} IN ('proposed', 'authorized', 'running', 'completed', 'failed', 'needs_confirmation')`
  ),
  uniqueIndex('meeting_todos_summary_displayed_number_unique')
    .on(table.summaryId, table.displayedNumber)
]);

export const projects = sqliteTable('projects', {
  projectKey: text('project_key').primaryKey(),
  displayName: text('display_name').notNull(),
  aliases: text('aliases').notNull(),
  localPathHint: text('local_path_hint'),
  repoUrl: text('repo_url'),
  defaultBranch: text('default_branch'),
  status: text('status', { enum: ['active', 'archived'] }).notNull(),
  origin: text('origin', {
    enum: ['discovered', 'human_confirmed', 'legacy_seed']
  }).notNull().default('legacy_seed'),
  stage: text('stage', {
    enum: ['idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed']
  }).notNull().default('active_project'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('projects_status_allowed', sql`${table.status} IN ('active', 'archived')`),
  check('projects_origin_allowed', sql`${table.origin} IN ('discovered', 'human_confirmed', 'legacy_seed')`),
  check(
    'projects_stage_allowed',
    sql`${table.stage} IN ('idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed')`
  )
]);

export const projectMappingRules = sqliteTable('project_mapping_rules', {
  id: text('id').primaryKey(),
  pattern: text('pattern').notNull(),
  patternKind: text('pattern_kind', { enum: ['keyword', 'exact', 'regex'] }).notNull(),
  projectKey: text('project_key').notNull().references(() => projects.projectKey),
  subprojectKey: text('subproject_key'),
  confidenceHint: text('confidence_hint', { enum: ['high', 'medium', 'low'] }).notNull(),
  priority: integer('priority').notNull(),
  source: text('source', { enum: ['system', 'ivy_correction'] }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('project_mapping_rules_pattern_kind_allowed', sql`${table.patternKind} IN ('keyword', 'exact', 'regex')`),
  check('project_mapping_rules_confidence_allowed', sql`${table.confidenceHint} IN ('high', 'medium', 'low')`),
  check('project_mapping_rules_source_allowed', sql`${table.source} IN ('system', 'ivy_correction')`),
  check('project_mapping_rules_active_allowed', sql`${table.active} IN (0, 1)`)
]);

export const projectContextSnapshots = sqliteTable('project_context_snapshots', {
  id: text('id').primaryKey(),
  projectKey: text('project_key').references(() => projects.projectKey),
  sourceKind: text('source_kind').notNull(),
  sourceRef: text('source_ref').notNull(),
  content: text('content').notNull(),
  digest: text('digest').notNull(),
  capturedAt: text('captured_at').notNull()
});

export const projectMappingConflicts = sqliteTable('project_mapping_conflicts', {
  id: text('id').primaryKey(),
  todoId: text('todo_id').references(() => meetingTodos.id),
  candidateProjectKey: text('candidate_project_key'),
  existingProjectKey: text('existing_project_key'),
  evidence: text('evidence').notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at')
}, (table) => [
  check('project_mapping_conflicts_status_allowed', sql`${table.status} IN ('open', 'resolved')`)
]);

export const batchJobs = sqliteTable('batch_jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  stableKey: text('stable_key').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull().default('queued'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  uniqueIndex('batch_jobs_stable_key_unique').on(table.stableKey)
]);

export const outbox = sqliteTable('outbox', {
  id: text('id').primaryKey(),
  destination: text('destination').notNull(),
  payload: text('payload').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  deliveredAt: text('delivered_at'),
  deliveredMessageId: text('delivered_message_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  lastErrorCode: text('last_error_code')
}, (table) => [
  uniqueIndex('outbox_idempotency_key_unique').on(table.idempotencyKey),
  uniqueIndex('outbox_delivered_message_id_unique').on(table.deliveredMessageId)
]);

export const approvalActions = sqliteTable('approval_actions', {
  id: text('id').primaryKey(),
  todoId: text('todo_id').notNull().references(() => meetingTodos.id),
  approverOpenId: text('approver_open_id').notNull(),
  action: text('action').notNull(),
  createdAt: text('created_at').notNull()
});

export const contextSources = sqliteTable('context_sources', {
  id: text('id').primaryKey(),
  sourceSystem: text('source_system').notNull(),
  sourceType: text('source_type').notNull(),
  externalId: text('external_id').notNull(),
  logicalKey: text('logical_key').notNull(),
  sourceVersion: integer('source_version').notNull(),
  occurredAt: text('occurred_at').notNull(),
  authorsJson: text('authors_json').notNull(),
  locatorUri: text('locator_uri'),
  contentFormat: text('content_format').notNull(),
  contentText: text('content_text').notNull(),
  metadataJson: text('metadata_json').notNull(),
  contentHash: text('content_hash').notNull(),
  availabilityStatus: text('availability_status', {
    enum: ['available', 'deleted', 'permission_lost', 'unknown']
  }).notNull(),
  capturedAt: text('captured_at').notNull()
}, (table) => [
  check('context_sources_version_positive', sql`${table.sourceVersion} > 0`),
  check('context_sources_availability_allowed', sql`${table.availabilityStatus} IN ('available', 'deleted', 'permission_lost', 'unknown')`),
  uniqueIndex('context_sources_logical_hash_unique').on(table.logicalKey, table.contentHash),
  uniqueIndex('context_sources_logical_version_unique').on(table.logicalKey, table.sourceVersion)
]);

export const contextSourceRelations = sqliteTable('context_source_relations', {
  fromSourceId: text('from_source_id').notNull().references(() => contextSources.id),
  toSourceId: text('to_source_id').notNull().references(() => contextSources.id),
  relationType: text('relation_type', { enum: ['derived_from', 'part_of', 'revises'] }).notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('context_source_relations_edge_unique')
    .on(table.fromSourceId, table.toSourceId, table.relationType)
]);

export const contextEvidence = sqliteTable('context_evidence', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => contextSources.id),
  sourceVersion: integer('source_version').notNull(),
  excerpt: text('excerpt').notNull(),
  locatorJson: text('locator_json').notNull(),
  excerptHash: text('excerpt_hash').notNull(),
  evidenceLevel: text('evidence_level', {
    enum: ['derived_summary', 'primary_statement', 'authoritative_record', 'direct_observation']
  }).notNull(),
  capturedAt: text('captured_at').notNull()
}, (table) => [
  uniqueIndex('context_evidence_identity_unique')
    .on(table.sourceId, table.excerptHash, table.locatorJson)
]);

export const contextExtractionRuns = sqliteTable('context_extraction_runs', {
  id: text('id').primaryKey(),
  sourceSetHash: text('source_set_hash').notNull(),
  extractorName: text('extractor_name').notNull(),
  extractorVersion: text('extractor_version').notNull(),
  promptVersion: text('prompt_version').notNull(),
  status: text('status', { enum: ['processing', 'completed', 'failed'] }).notNull(),
  errorCode: text('error_code'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at')
}, (table) => [
  uniqueIndex('context_extraction_runs_identity_unique')
    .on(table.sourceSetHash, table.extractorName, table.extractorVersion, table.promptVersion)
]);

export const contextExtractionRunSources = sqliteTable('context_extraction_run_sources', {
  extractionRunId: text('extraction_run_id').notNull().references(() => contextExtractionRuns.id),
  sourceId: text('source_id').notNull().references(() => contextSources.id),
  sourceRole: text('source_role', { enum: ['primary', 'context'] }).notNull()
}, (table) => [
  uniqueIndex('context_extraction_run_sources_unique').on(table.extractionRunId, table.sourceId)
]);

export const contextCandidates = sqliteTable('context_candidates', {
  id: text('id').primaryKey(),
  extractionRunId: text('extraction_run_id').notNull().references(() => contextExtractionRuns.id),
  candidateType: text('candidate_type', {
    enum: ['proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker', 'requirement', 'status_update', 'action_item']
  }).notNull(),
  scope: text('scope', { enum: ['company', 'project'] }).notNull(),
  summary: text('summary').notNull(),
  subjectKey: text('subject_key'),
  structuredPayload: text('structured_payload').notNull(),
  extractionConfidence: real('extraction_confidence').notNull(),
  factualStatus: text('factual_status', {
    enum: ['source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed']
  }).notNull(),
  reviewStatus: text('review_status', {
    enum: ['pending', 'approved', 'rejected', 'needs_clarification', 'conflict']
  }).notNull(),
  candidateFingerprint: text('candidate_fingerprint').notNull(),
  externalRefsJson: text('external_refs_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('context_candidates_confidence_range', sql`${table.extractionConfidence} >= 0 AND ${table.extractionConfidence} <= 1`),
  uniqueIndex('context_candidates_fingerprint_unique').on(table.candidateFingerprint)
]);

export const contextCandidateProjects = sqliteTable('context_candidate_projects', {
  candidateId: text('candidate_id').notNull().references(() => contextCandidates.id),
  projectKey: text('project_key').references(() => projects.projectKey),
  projectRole: text('project_role', { enum: ['primary', 'related'] }).notNull(),
  mappingStatus: text('mapping_status', {
    enum: ['mapped', 'needs_confirmation', 'unmapped', 'conflict']
  }).notNull(),
  mappingConfidence: text('mapping_confidence', { enum: ['high', 'medium', 'low'] }).notNull(),
  mappingEvidence: text('mapping_evidence').notNull()
}, (table) => [
  uniqueIndex('context_candidate_projects_unique')
    .on(table.candidateId, table.projectKey, table.projectRole)
]);

export const contextCandidateEvidence = sqliteTable('context_candidate_evidence', {
  candidateId: text('candidate_id').notNull().references(() => contextCandidates.id),
  evidenceId: text('evidence_id').notNull().references(() => contextEvidence.id),
  evidenceRole: text('evidence_role', { enum: ['supporting', 'contradicting', 'context'] }).notNull()
}, (table) => [
  uniqueIndex('context_candidate_evidence_unique')
    .on(table.candidateId, table.evidenceId, table.evidenceRole)
]);

export const contextCandidateRecordRelations = sqliteTable('context_candidate_record_relations', {
  candidateId: text('candidate_id').notNull().references(() => contextCandidates.id),
  recordId: text('record_id').notNull().references(() => contextRecords.id),
  relationType: text('relation_type', {
    enum: ['supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates']
  }).notNull(),
  status: text('status', { enum: ['suggested', 'confirmed', 'rejected'] }).notNull(),
  rationale: text('rationale').notNull()
}, (table) => [
  uniqueIndex('context_candidate_record_relations_unique')
    .on(table.candidateId, table.recordId, table.relationType)
]);

export const contextReviews = sqliteTable('context_reviews', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').notNull().references(() => contextCandidates.id),
  action: text('action', { enum: ['approve', 'reject', 'request_clarification', 'mark_conflict'] }).notNull(),
  reviewerOpenId: text('reviewer_open_id').notNull(),
  approvedSummary: text('approved_summary'),
  approvedPayload: text('approved_payload'),
  decidedFactualStatus: text('decided_factual_status', {
    enum: ['source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed']
  }),
  targetRecordId: text('target_record_id').references(() => contextRecords.id),
  relationType: text('relation_type', {
    enum: ['supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates']
  }),
  reason: text('reason'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('context_reviews_idempotency_unique').on(table.idempotencyKey)
]);

export const contextRecords = sqliteTable('context_records', {
  id: text('id').primaryKey(),
  recordType: text('record_type', {
    enum: ['proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker', 'requirement', 'status_update', 'action_item']
  }).notNull(),
  scope: text('scope', { enum: ['company', 'project'] }).notNull(),
  subjectKey: text('subject_key'),
  lifecycleStatus: text('lifecycle_status', { enum: ['active', 'disputed', 'archived'] }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const contextRecordVersions = sqliteTable('context_record_versions', {
  id: text('id').primaryKey(),
  recordId: text('record_id').notNull().references(() => contextRecords.id),
  versionNumber: integer('version_number').notNull(),
  summary: text('summary').notNull(),
  structuredPayload: text('structured_payload').notNull(),
  factualStatus: text('factual_status', {
    enum: ['source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed']
  }).notNull(),
  sourceCandidateId: text('source_candidate_id').notNull().references(() => contextCandidates.id),
  reviewerOpenId: text('reviewer_open_id').notNull(),
  reviewedAt: text('reviewed_at').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('context_record_versions_record_version_unique').on(table.recordId, table.versionNumber)
]);

export const contextRecordProjects = sqliteTable('context_record_projects', {
  recordVersionId: text('record_version_id').notNull().references(() => contextRecordVersions.id),
  projectKey: text('project_key').notNull().references(() => projects.projectKey),
  projectRole: text('project_role', { enum: ['primary', 'related'] }).notNull()
}, (table) => [
  uniqueIndex('context_record_projects_unique').on(table.recordVersionId, table.projectKey, table.projectRole)
]);

export const contextRecordEvidence = sqliteTable('context_record_evidence', {
  recordVersionId: text('record_version_id').notNull().references(() => contextRecordVersions.id),
  evidenceId: text('evidence_id').notNull().references(() => contextEvidence.id),
  evidenceRole: text('evidence_role', { enum: ['supporting', 'contradicting', 'context'] }).notNull()
}, (table) => [
  uniqueIndex('context_record_evidence_unique').on(table.recordVersionId, table.evidenceId, table.evidenceRole)
]);

export const contextRecordRelations = sqliteTable('context_record_relations', {
  id: text('id').primaryKey(),
  fromRecordVersionId: text('from_record_version_id').notNull().references(() => contextRecordVersions.id),
  toRecordVersionId: text('to_record_version_id').notNull().references(() => contextRecordVersions.id),
  relationType: text('relation_type', {
    enum: ['supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates']
  }).notNull(),
  reviewId: text('review_id').notNull().references(() => contextReviews.id),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('context_record_relations_unique')
    .on(table.fromRecordVersionId, table.toRecordVersionId, table.relationType)
]);
