import type Database from 'better-sqlite3';

export type ProjectSpaceBindingStatus = 'active' | 'paused' | 'permission_lost';
export type ProjectSpaceManagementMode = 'space' | 'hybrid';
export type ProjectSpaceSyncMode = 'manual' | 'scheduled' | 'event';

export interface CreateProjectSpaceBindingInput {
  id: string;
  projectKey: string;
  spaceId: string | null;
  pageId: string;
  pageUrl: string;
  managementMode: ProjectSpaceManagementMode;
  syncMode: ProjectSpaceSyncMode;
  createdAt: Date;
}

export interface ProjectSpaceBindingRecord {
  id: string;
  projectKey: string;
  provider: 'chatgpt_space';
  spaceId: string | null;
  pageId: string;
  pageUrl: string;
  managementMode: ProjectSpaceManagementMode;
  syncMode: ProjectSpaceSyncMode;
  status: ProjectSpaceBindingStatus;
  lastSeenSequence: number | null;
  lastPageUpdatedAt: string | null;
  lastSyncedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordSuccessfulSyncInput {
  bindingId: string;
  pageSequence: number | null;
  pageUpdatedAt: string | null;
  syncedAt: Date;
}

export interface RecordSyncFailureInput {
  bindingId: string;
  errorCode: string;
  attemptedAt: Date;
  status?: ProjectSpaceBindingStatus;
}

export interface SpaceSyncRunRecord {
  id: string;
  bindingId: string;
  projectKey: string;
  pageId: string;
  trigger: 'manual' | 'scheduled' | 'event';
  envelopeHash: string;
  status: 'completed';
  errorCode: string | null;
  pageSourceCreated: boolean;
  commentSourcesCreated: number;
  coveragePageComplete: boolean;
  coverageCommentsComplete: boolean;
  nextCursor: string | null;
  gapCount: number;
  startedAt: string;
  completedAt: string;
}

export interface InsertSpaceSyncRunInput {
  syncId: string;
  bindingId: string;
  projectKey: string;
  pageId: string;
  trigger: 'manual' | 'scheduled' | 'event';
  envelopeHash: string;
  pageSourceCreated: boolean;
  commentSourcesCreated: number;
  coveragePageComplete: boolean;
  coverageCommentsComplete: boolean;
  nextCursor: string | null;
  gapCount: number;
  startedAt: Date;
  completedAt: Date;
}

export class SpaceSyncRepository {
  constructor(readonly client: Database.Database) {}

  createBinding(input: CreateProjectSpaceBindingInput): ProjectSpaceBindingRecord {
    const timestamp = input.createdAt.toISOString();
    this.client.prepare(`
      INSERT INTO project_space_bindings (
        id, project_key, provider, space_id, page_id, page_url, management_mode,
        sync_mode, status, created_at, updated_at
      ) VALUES (?, ?, 'chatgpt_space', ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(input.id, input.projectKey, input.spaceId, input.pageId, input.pageUrl,
      input.managementMode, input.syncMode, timestamp, timestamp);
    return this.getBindingByIdOrThrow(input.id);
  }

  getBindingById(id: string): ProjectSpaceBindingRecord | null {
    const row = this.client.prepare('SELECT * FROM project_space_bindings WHERE id = ?')
      .get(id) as BindingRow | undefined;
    return row ? toBindingRecord(row) : null;
  }

  getBindingByPageId(pageId: string): ProjectSpaceBindingRecord | null {
    const row = this.client.prepare('SELECT * FROM project_space_bindings WHERE page_id = ?')
      .get(pageId) as BindingRow | undefined;
    return row ? toBindingRecord(row) : null;
  }

  /** Worker eligibility is scoped by projectKey, not pageId — see founder-stream-worker.ts. */
  getBindingByProjectKey(projectKey: string): ProjectSpaceBindingRecord | null {
    const row = this.client.prepare('SELECT * FROM project_space_bindings WHERE project_key = ?')
      .get(projectKey) as BindingRow | undefined;
    return row ? toBindingRecord(row) : null;
  }

  recordSuccessfulSync(input: RecordSuccessfulSyncInput): void {
    const timestamp = input.syncedAt.toISOString();
    const result = this.client.prepare(`
      UPDATE project_space_bindings
      SET last_seen_sequence = ?, last_page_updated_at = ?, last_synced_at = ?,
        last_successful_sync_at = ?, last_error_code = NULL, status = 'active', updated_at = ?
      WHERE id = ?
    `).run(input.pageSequence, input.pageUpdatedAt, timestamp, timestamp, timestamp, input.bindingId);
    if (result.changes !== 1) throw new Error('SPACE_SYNC_BINDING_NOT_FOUND');
  }

  recordSyncFailure(input: RecordSyncFailureInput): void {
    const timestamp = input.attemptedAt.toISOString();
    const result = this.client.prepare(`
      UPDATE project_space_bindings
      SET last_synced_at = ?, last_error_code = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(timestamp, input.errorCode, input.status ?? 'permission_lost', timestamp, input.bindingId);
    if (result.changes !== 1) throw new Error('SPACE_SYNC_BINDING_NOT_FOUND');
  }

  getRunBySyncId(syncId: string): SpaceSyncRunRecord | null {
    const row = this.client.prepare('SELECT * FROM space_sync_runs WHERE id = ?')
      .get(syncId) as RunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  getLatestRunForBinding(bindingId: string): SpaceSyncRunRecord | null {
    const row = this.client.prepare(`
      SELECT * FROM space_sync_runs WHERE binding_id = ? ORDER BY completed_at DESC, id DESC LIMIT 1
    `).get(bindingId) as RunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  insertRun(input: InsertSpaceSyncRunInput): SpaceSyncRunRecord {
    this.client.prepare(`
      INSERT INTO space_sync_runs (
        id, binding_id, project_key, page_id, trigger, envelope_hash,
        page_source_created, comment_sources_created, coverage_page_complete,
        coverage_comments_complete, next_cursor, gap_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.syncId, input.bindingId, input.projectKey, input.pageId, input.trigger,
      input.envelopeHash, input.pageSourceCreated ? 1 : 0, input.commentSourcesCreated,
      input.coveragePageComplete ? 1 : 0, input.coverageCommentsComplete ? 1 : 0,
      input.nextCursor, input.gapCount, input.startedAt.toISOString(), input.completedAt.toISOString());
    const run = this.getRunBySyncId(input.syncId);
    if (!run) throw new Error('space sync run insert could not be read back');
    return run;
  }

  private getBindingByIdOrThrow(id: string): ProjectSpaceBindingRecord {
    const binding = this.getBindingById(id);
    if (!binding) throw new Error('project space binding not found');
    return binding;
  }
}

interface BindingRow {
  id: string; project_key: string; provider: 'chatgpt_space'; space_id: string | null;
  page_id: string; page_url: string; management_mode: ProjectSpaceManagementMode;
  sync_mode: ProjectSpaceSyncMode; status: ProjectSpaceBindingStatus;
  last_seen_sequence: number | null; last_page_updated_at: string | null;
  last_synced_at: string | null; last_successful_sync_at: string | null;
  last_error_code: string | null; created_at: string; updated_at: string;
}

interface RunRow {
  id: string; binding_id: string; project_key: string; page_id: string;
  trigger: 'manual' | 'scheduled' | 'event'; envelope_hash: string; status: 'completed';
  error_code: string | null; page_source_created: number; comment_sources_created: number;
  coverage_page_complete: number; coverage_comments_complete: number;
  next_cursor: string | null; gap_count: number; started_at: string; completed_at: string;
}

function toBindingRecord(row: BindingRow): ProjectSpaceBindingRecord {
  return {
    id: row.id, projectKey: row.project_key, provider: row.provider, spaceId: row.space_id,
    pageId: row.page_id, pageUrl: row.page_url, managementMode: row.management_mode,
    syncMode: row.sync_mode, status: row.status, lastSeenSequence: row.last_seen_sequence,
    lastPageUpdatedAt: row.last_page_updated_at, lastSyncedAt: row.last_synced_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at, lastErrorCode: row.last_error_code,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function toRunRecord(row: RunRow): SpaceSyncRunRecord {
  return {
    id: row.id, bindingId: row.binding_id, projectKey: row.project_key, pageId: row.page_id,
    trigger: row.trigger, envelopeHash: row.envelope_hash, status: row.status,
    errorCode: row.error_code, pageSourceCreated: row.page_source_created === 1,
    commentSourcesCreated: row.comment_sources_created,
    coveragePageComplete: row.coverage_page_complete === 1,
    coverageCommentsComplete: row.coverage_comments_complete === 1,
    nextCursor: row.next_cursor, gapCount: row.gap_count,
    startedAt: row.started_at, completedAt: row.completed_at
  };
}
