import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('projects_status_allowed', sql`${table.status} IN ('active', 'archived')`)
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
  deliveredAt: text('delivered_at')
}, (table) => [
  uniqueIndex('outbox_idempotency_key_unique').on(table.idempotencyKey)
]);

export const approvalActions = sqliteTable('approval_actions', {
  id: text('id').primaryKey(),
  todoId: text('todo_id').notNull().references(() => meetingTodos.id),
  approverOpenId: text('approver_open_id').notNull(),
  action: text('action').notNull(),
  createdAt: text('created_at').notNull()
});
