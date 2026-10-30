import type Database from 'better-sqlite3';
import { stableId } from '../services/canonical-json.js';
import {
  spaceProjectDigestSchema, storedSpaceProjectDigestSchema, type SpaceProjectDigest, type StoredSpaceProjectDigest
} from '../services/space-project-digest.js';

export interface SpaceProjectDigestRecord {
  projectKey: string;
  pageId: string;
  pageSourceId: string;
  pageSourceVersion: number;
  pageUpdatedAt: string;
  status: 'ready' | 'failed';
  changeBasis: 'version_diff' | 'first_snapshot' | null;
  digest: StoredSpaceProjectDigest | null;
  failureCode: string | null;
  generatedAt: string;
}

interface SaveBase { projectKey: string; pageId: string; pageSourceId: string; pageSourceVersion: number;
  pageUpdatedAt: string; generatedAt: Date }

/**
 * One digest per stored page version; a ready digest is never replaced by a later failure. The one exception to
 * "ready stays": a digest stored before profiles (or their 待决定 list) existed is replaced once by a current one.
 */
export class SpaceProjectDigestRepository {
  constructor(readonly client: Database.Database) {}

  saveReady(input: SaveBase & { changeBasis: 'version_diff' | 'first_snapshot'; digest: SpaceProjectDigest }): void {
    const digest = spaceProjectDigestSchema.parse(input.digest);
    this.client.prepare(`
      INSERT INTO space_project_digests (id, project_key, page_id, page_source_id, page_source_version, page_updated_at,
        status, change_basis, digest_json, failure_code, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL, ?)
      ON CONFLICT(page_source_id) DO UPDATE SET status='ready', change_basis=excluded.change_basis,
        digest_json=excluded.digest_json, failure_code=NULL, generated_at=excluded.generated_at
      WHERE space_project_digests.status <> 'ready' OR json_extract(space_project_digests.digest_json, '$.profile') IS NULL
        OR json_extract(space_project_digests.digest_json, '$.profile.decisions') IS NULL
    `).run(digestId(input.pageSourceId), input.projectKey, input.pageId, input.pageSourceId, input.pageSourceVersion,
      input.pageUpdatedAt, input.changeBasis, JSON.stringify(digest), input.generatedAt.toISOString());
  }

  saveFailed(input: SaveBase & { failureCode: string }): void {
    this.client.prepare(`
      INSERT INTO space_project_digests (id, project_key, page_id, page_source_id, page_source_version, page_updated_at,
        status, change_basis, digest_json, failure_code, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'failed', NULL, NULL, ?, ?)
      ON CONFLICT(page_source_id) DO UPDATE SET failure_code=excluded.failure_code, generated_at=excluded.generated_at
      WHERE space_project_digests.status = 'failed'
    `).run(digestId(input.pageSourceId), input.projectKey, input.pageId, input.pageSourceId, input.pageSourceVersion,
      input.pageUpdatedAt, input.failureCode, input.generatedAt.toISOString());
  }

  getForPageSource(pageSourceId: string): SpaceProjectDigestRecord | null {
    const row = this.client.prepare('SELECT * FROM space_project_digests WHERE page_source_id = ?').get(pageSourceId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** The newest ready digest at or before `pageSourceVersion`, for carrying section choices over to the next version of the page. */
  getReadyAtOrBefore(projectKey: string, pageSourceVersion: number): SpaceProjectDigestRecord | null {
    const row = this.client.prepare(`SELECT * FROM space_project_digests WHERE project_key = ? AND status = 'ready'
      AND page_source_version <= ? ORDER BY page_source_version DESC LIMIT 1`).get(projectKey, pageSourceVersion) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * The digest of the newest page version that has one (ready or failed), so a failure is shown, not hidden. Newest is the
   * highest version: page times mix "+08:00" and "Z" offsets, which do not sort correctly as text.
   */
  getLatestForProject(projectKey: string): SpaceProjectDigestRecord | null {
    const row = this.client.prepare(`SELECT * FROM space_project_digests WHERE project_key = ?
      ORDER BY page_source_version DESC LIMIT 1`).get(projectKey) as Row | undefined;
    return row ? toRecord(row) : null;
  }
}

function digestId(pageSourceId: string): string { return stableId('spacedigest', pageSourceId); }

interface Row {
  project_key: string; page_id: string; page_source_id: string; page_source_version: number; page_updated_at: string;
  status: 'ready' | 'failed'; change_basis: 'version_diff' | 'first_snapshot' | null; digest_json: string | null;
  failure_code: string | null; generated_at: string;
}

function toRecord(row: Row): SpaceProjectDigestRecord {
  return { projectKey: row.project_key, pageId: row.page_id, pageSourceId: row.page_source_id,
    pageSourceVersion: row.page_source_version, pageUpdatedAt: row.page_updated_at, status: row.status,
    changeBasis: row.change_basis, digest: row.digest_json ? storedSpaceProjectDigestSchema.parse(JSON.parse(row.digest_json)) : null,
    failureCode: row.failure_code, generatedAt: row.generated_at };
}
