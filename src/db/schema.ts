import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const feishuEvents = sqliteTable('feishu_events', {
  eventId: text('event_id').primaryKey(),
  minuteId: text('minute_id').notNull(),
  receivedAt: text('received_at').notNull()
});

export const founderStreamEvents = sqliteTable('founder_stream_events', {
  eventId: text('event_id').primaryKey(), messageId: text('message_id').notNull(),
  chatId: text('chat_id').notNull(), disposition: text('disposition').notNull(), receivedAt: text('received_at').notNull()
}, (table) => [check('founder_stream_events_disposition', sql`${table.disposition} IN ('captured','bot_audit','feedback','skipped_media')`)]);

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

export const founderFeedbackCorrections = sqliteTable('founder_feedback_corrections', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  authorOpenId: text('author_open_id').notNull(),
  bindingMessageId: text('binding_message_id').notNull(),
  evidenceId: text('evidence_id').notNull().references(() => contextEvidence.id),
  inputHash: text('input_hash').notNull(),
  correctionJson: text('correction_json').notNull(),
  resultJson: text('result_json').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [uniqueIndex('founder_feedback_source_unique').on(table.chatId, table.sourceMessageId)]);

export const founderFeedbackDrafts = sqliteTable('founder_feedback_drafts', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  mapId: text('map_id').notNull(),
  bindingMessageId: text('binding_message_id').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  authorOpenId: text('author_open_id').notNull(),
  inputHash: text('input_hash').notNull(),
  inputJson: text('input_json').notNull(),
  operationsJson: text('operations_json').notNull(),
  status: text('status', { enum: ['pending', 'applied', 'cancelled'] }).notNull(),
  createdAt: text('created_at').notNull(),
  appliedAt: text('applied_at')
}, (table) => [
  uniqueIndex('founder_feedback_drafts_source_unique').on(table.chatId, table.sourceMessageId),
  check('founder_feedback_drafts_status_allowed', sql`${table.status} IN ('pending','applied','cancelled')`)
]);

export const founderWorkMapPreferences = sqliteTable('founder_work_map_preferences', {
  chatId: text('chat_id').primaryKey(),
  hideOrphanActive: integer('hide_orphan_active').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [check('founder_work_map_preferences_hide_orphan_active_allowed', sql`${table.hideOrphanActive} IN (0,1)`) ]);

export const alignmentIssues = sqliteTable('alignment_issues', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => contextTopics.id),
  decisionKey: text('decision_key').notNull(),
  dimension: text('dimension').notNull(),
  evidenceSetHash: text('evidence_set_hash').notNull(),
  candidateJson: text('candidate_json').notNull(),
  status: text('status').notNull(),
  deliveredMessageId: text('delivered_message_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  uniqueIndex('alignment_issues_evidence_unique').on(table.topicId, table.decisionKey, table.dimension, table.evidenceSetHash),
  check('alignment_issues_dimension_allowed', sql`${table.dimension} IN ('direction','next_action','owner','deadline','completion_standard')`),
  check('alignment_issues_status_allowed', sql`${table.status} IN ('candidate','ready','asked','resolved','dismissed','stale')`)
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
  capturedAt: text('captured_at').notNull(),
  rawTextExpiresAt: text('raw_text_expires_at'),
  contentState: text('content_state', { enum: ['cleartext', 'redacted'] }).notNull().default('cleartext'),
  redactedAt: text('redacted_at')
}, (table) => [
  check('context_sources_version_positive', sql`${table.sourceVersion} > 0`),
  check('context_sources_availability_allowed', sql`${table.availabilityStatus} IN ('available', 'deleted', 'permission_lost', 'unknown')`),
  check('context_sources_content_state_allowed', sql`${table.contentState} IN ('cleartext', 'redacted')`),
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

export const contextTopics = sqliteTable('context_topics', {
  id: text('id').primaryKey(),
  currentVersion: integer('current_version').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('context_topics_current_version_positive', sql`${table.currentVersion} > 0`)
]);

export const founderTopicVisibility = sqliteTable('founder_topic_visibility', {
  topicId: text('topic_id').primaryKey().references(() => contextTopics.id),
  visibility: text('visibility', { enum: ['visible', 'space_managed'] }).notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [check('founder_topic_visibility_allowed', sql`${table.visibility} IN ('visible','space_managed')`)]);

export const contextTopicVersions = sqliteTable('context_topic_versions', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => contextTopics.id),
  versionNumber: integer('version_number').notNull(),
  displayName: text('display_name').notNull(),
  stage: text('stage', {
    enum: ['idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed']
  }).notNull(),
  outcome: text('outcome'),
  rationale: text('rationale').notNull(),
  evidenceIdsJson: text('evidence_ids_json').notNull(),
  changedAt: text('changed_at').notNull()
}, (table) => [
  check('context_topic_versions_number_positive', sql`${table.versionNumber} > 0`),
  check(
    'context_topic_versions_stage_allowed',
    sql`${table.stage} IN ('idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed')`
  ),
  uniqueIndex('context_topic_versions_topic_version_unique')
    .on(table.topicId, table.versionNumber)
]);

export const contextTopicSources = sqliteTable('context_topic_sources', {
  id: text('id').primaryKey(),
  topicVersionId: text('topic_version_id').notNull().references(() => contextTopicVersions.id),
  sourceId: text('source_id').notNull().references(() => contextSources.id),
  evidenceId: text('evidence_id').references(() => contextEvidence.id),
  addedAt: text('added_at').notNull()
}, (table) => [
  uniqueIndex('context_topic_sources_stable_unique')
    .on(table.topicVersionId, table.sourceId, table.evidenceId)
]);

export const contextTopicRelations = sqliteTable('context_topic_relations', {
  id: text('id').primaryKey(),
  fromTopicId: text('from_topic_id').notNull().references(() => contextTopics.id),
  fromTopicVersionId: text('from_topic_version_id').notNull().references(() => contextTopicVersions.id),
  toTopicId: text('to_topic_id').notNull().references(() => contextTopics.id),
  toTopicVersionId: text('to_topic_version_id').notNull().references(() => contextTopicVersions.id),
  relationType: text('relation_type', {
    enum: ['same_as', 'split_from', 'part_of', 'related_to', 'supersedes']
  }).notNull(),
  rationale: text('rationale').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  check('context_topic_relations_distinct_topics', sql`${table.fromTopicId} <> ${table.toTopicId}`),
  check(
    'context_topic_relations_type_allowed',
    sql`${table.relationType} IN ('same_as', 'split_from', 'part_of', 'related_to', 'supersedes')`
  ),
  uniqueIndex('context_topic_relations_stable_unique')
    .on(table.fromTopicId, table.toTopicId, table.relationType)
]);

export const founderIdentities = sqliteTable('founder_identities', {
  id: text('id').primaryKey(),
  founder: text('founder', { enum: ['ivy', 'james'] }).notNull(),
  sourceSystem: text('source_system').notNull(),
  externalAuthorId: text('external_author_id').notNull(),
  configuredAt: text('configured_at').notNull()
}, (table) => [
  check('founder_identities_founder_allowed', sql`${table.founder} IN ('ivy', 'james')`),
  uniqueIndex('founder_identities_source_author_unique')
    .on(table.sourceSystem, table.externalAuthorId)
]);

export const topicPerspectives = sqliteTable('topic_perspectives', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => contextTopics.id),
  kind: text('kind', {
    enum: ['ivy_view', 'james_view', 'shared_decision', 'unresolved']
  }).notNull(),
  currentVersion: integer('current_version').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check(
    'topic_perspectives_kind_allowed',
    sql`${table.kind} IN ('ivy_view', 'james_view', 'shared_decision', 'unresolved')`
  ),
  check('topic_perspectives_current_version_positive', sql`${table.currentVersion} > 0`),
  uniqueIndex('topic_perspectives_topic_kind_unique').on(table.topicId, table.kind)
]);

export const topicPerspectiveVersions = sqliteTable('topic_perspective_versions', {
  id: text('id').primaryKey(),
  perspectiveId: text('perspective_id').notNull().references(() => topicPerspectives.id),
  versionNumber: integer('version_number').notNull(),
  statement: text('statement').notNull(),
  confidence: real('confidence').notNull(),
  evidenceIdsJson: text('evidence_ids_json').notNull(),
  decisionKey: text('decision_key'),
  speechAct: text('speech_act', {
    enum: ['view', 'decision_proposal', 'explicit_agreement', 'explicit_disagreement']
  }).notNull(),
  observedAt: text('observed_at').notNull()
}, (table) => [
  check('topic_perspective_versions_number_positive', sql`${table.versionNumber} > 0`),
  check(
    'topic_perspective_versions_confidence_range',
    sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`
  ),
  check(
    'topic_perspective_versions_speech_act_allowed',
    sql`${table.speechAct} IN ('view', 'decision_proposal', 'explicit_agreement', 'explicit_disagreement')`
  ),
  uniqueIndex('topic_perspective_versions_perspective_version_unique')
    .on(table.perspectiveId, table.versionNumber)
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

export const founderPerspectiveObservations = sqliteTable('founder_perspective_observations', {
  topicId:text('topic_id').notNull().references(()=>contextTopics.id),
  evidenceId:text('evidence_id').notNull().references(()=>contextEvidence.id),
  statement:text('statement').notNull(),speechAct:text('speech_act').notNull(),decisionKey:text('decision_key')
}, table=>[primaryKey({columns:[table.topicId,table.evidenceId]})]);

export const projectSpaceBindings = sqliteTable('project_space_bindings', {
  id: text('id').primaryKey(),
  projectKey: text('project_key').notNull().references(() => projects.projectKey),
  provider: text('provider', { enum: ['chatgpt_space'] }).notNull(),
  spaceId: text('space_id'),
  pageId: text('page_id').notNull(),
  pageUrl: text('page_url').notNull(),
  managementMode: text('management_mode', { enum: ['space', 'hybrid'] }).notNull(),
  syncMode: text('sync_mode', { enum: ['manual', 'scheduled', 'event'] }).notNull(),
  status: text('status', { enum: ['active', 'paused', 'permission_lost'] }).notNull(),
  lastSeenSequence: integer('last_seen_sequence'),
  lastPageUpdatedAt: text('last_page_updated_at'),
  lastSyncedAt: text('last_synced_at'),
  lastSuccessfulSyncAt: text('last_successful_sync_at'),
  lastErrorCode: text('last_error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('project_space_bindings_provider_allowed', sql`${table.provider} IN ('chatgpt_space')`),
  check('project_space_bindings_management_mode_allowed', sql`${table.managementMode} IN ('space', 'hybrid')`),
  check('project_space_bindings_sync_mode_allowed', sql`${table.syncMode} IN ('manual', 'scheduled', 'event')`),
  check('project_space_bindings_status_allowed', sql`${table.status} IN ('active', 'paused', 'permission_lost')`),
  uniqueIndex('project_space_bindings_page_id_unique').on(table.pageId)
]);

export const founderTopicProjectBindings = sqliteTable('founder_topic_project_bindings', {
  topicId: text('topic_id').notNull().references(() => contextTopics.id),
  projectKey: text('project_key').notNull().references(() => projects.projectKey),
  role: text('role', { enum: ['canonical', 'child', 'related'] }).notNull(),
  source: text('source', { enum: ['human_confirmed', 'mapping_rule', 'analysis'] }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('founder_topic_project_bindings_role_allowed', sql`${table.role} IN ('canonical', 'child', 'related')`),
  check('founder_topic_project_bindings_source_allowed', sql`${table.source} IN ('human_confirmed', 'mapping_rule', 'analysis')`),
  primaryKey({ columns: [table.topicId, table.projectKey, table.role] })
]);

export const spaceSyncRuns = sqliteTable('space_sync_runs', {
  id: text('id').primaryKey(),
  bindingId: text('binding_id').notNull().references(() => projectSpaceBindings.id),
  projectKey: text('project_key').notNull().references(() => projects.projectKey),
  pageId: text('page_id').notNull(),
  trigger: text('trigger', { enum: ['manual', 'scheduled', 'event'] }).notNull(),
  envelopeHash: text('envelope_hash').notNull(),
  status: text('status', { enum: ['completed'] }).notNull().default('completed'),
  errorCode: text('error_code'),
  pageSourceCreated: integer('page_source_created').notNull(),
  commentSourcesCreated: integer('comment_sources_created').notNull().default(0),
  coveragePageComplete: integer('coverage_page_complete').notNull(),
  coverageCommentsComplete: integer('coverage_comments_complete').notNull(),
  nextCursor: text('next_cursor'),
  gapCount: integer('gap_count').notNull().default(0),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull()
}, (table) => [
  check('space_sync_runs_trigger_allowed', sql`${table.trigger} IN ('manual', 'scheduled', 'event')`),
  check('space_sync_runs_status_allowed', sql`${table.status} IN ('completed')`),
  check('space_sync_runs_page_source_created_bool', sql`${table.pageSourceCreated} IN (0, 1)`),
  check('space_sync_runs_coverage_page_complete_bool', sql`${table.coveragePageComplete} IN (0, 1)`),
  check('space_sync_runs_coverage_comments_complete_bool', sql`${table.coverageCommentsComplete} IN (0, 1)`)
]);

export const spaceProjectDigests = sqliteTable('space_project_digests', {
  id: text('id').primaryKey(),
  projectKey: text('project_key').notNull().references(() => projects.projectKey),
  pageId: text('page_id').notNull(),
  pageSourceId: text('page_source_id').notNull().references(() => contextSources.id),
  pageSourceVersion: integer('page_source_version').notNull(),
  pageUpdatedAt: text('page_updated_at').notNull(),
  status: text('status', { enum: ['ready', 'failed'] }).notNull(),
  changeBasis: text('change_basis', { enum: ['version_diff', 'first_snapshot'] }),
  digestJson: text('digest_json'),
  failureCode: text('failure_code'),
  generatedAt: text('generated_at').notNull()
}, (table) => [
  check('space_project_digests_status_allowed', sql`${table.status} IN ('ready', 'failed')`),
  check('space_project_digests_change_basis_allowed', sql`${table.changeBasis} IN ('version_diff', 'first_snapshot')`),
  uniqueIndex('space_project_digests_page_source_unique').on(table.pageSourceId)
]);

/** Current open/resolved state per thread; comment bodies stay immutable sources, so a resolution is tracked here. */
export const spaceCommentThreads = sqliteTable('space_comment_threads', {
  pageId: text('page_id').notNull(),
  threadId: text('thread_id').notNull(),
  threadState: text('thread_state', { enum: ['open', 'resolved'] }).notNull(),
  resolvedAt: text('resolved_at'),
  observedAt: text('observed_at').notNull()
}, (table) => [
  check('space_comment_threads_state_allowed', sql`${table.threadState} IN ('open', 'resolved')`),
  primaryKey({ columns: [table.pageId, table.threadId] })
]);
