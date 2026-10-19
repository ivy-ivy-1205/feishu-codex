import type Database from 'better-sqlite3';
import {
  contextEvidenceLocatorSchema,
  type ContextEvidenceLocator,
  type ContextEvidenceLocatorInput,
  type ContextEvidenceLevel,
} from '../domain/context.js';
import { canonicalJson, sha256, stableId } from '../services/canonical-json.js';
import { validateContextEvidenceLocator } from '../services/context-evidence-locator.js';

export type ContextSourceAvailability = 'available' | 'deleted' | 'permission_lost' | 'unknown';
export type ContextSourceContentState = 'cleartext' | 'redacted';

export const retentionRedactionPlaceholder = '[REDACTED:RETENTION_EXPIRED]';

export interface SaveContextSourceInput {
  sourceSystem: string;
  sourceType: string;
  externalId: string;
  logicalKey: string;
  occurredAt: string;
  authors: readonly Record<string, unknown>[];
  locatorUri: string | null;
  contentFormat: string;
  contentText: string;
  metadata: Record<string, unknown>;
  availabilityStatus: ContextSourceAvailability;
  capturedAt: Date;
  rawTextExpiresAt?: Date | null;
}

export interface ContextSourceRecord {
  id: string;
  sourceSystem: string;
  sourceType: string;
  externalId: string;
  logicalKey: string;
  sourceVersion: number;
  occurredAt: string;
  authors: readonly Record<string, unknown>[];
  locatorUri: string | null;
  contentFormat: string;
  contentText: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  availabilityStatus: ContextSourceAvailability;
  capturedAt: string;
  rawTextExpiresAt: string | null;
  contentState: ContextSourceContentState;
  redactedAt: string | null;
}

export interface ExpiredRawTextPreview {
  id: string;
  sourceType: string;
  rawTextExpiresAt: string;
}

export interface SaveEvidenceInput {
  sourceId: string;
  excerpt: string;
  locator: ContextEvidenceLocatorInput;
  evidenceLevel: ContextEvidenceLevel;
  capturedAt: Date;
}

export interface ContextEvidenceRecord {
  id: string;
  sourceId: string;
  sourceVersion: number;
  excerpt: string;
  locator: ContextEvidenceLocator;
  excerptHash: string;
  evidenceLevel: ContextEvidenceLevel;
  capturedAt: string;
}

export interface BeginExtractionRunInput {
  sources: readonly { id: string; contentHash: string }[];
  extractorName: string;
  extractorVersion: string;
  promptVersion: string;
  startedAt: Date;
}

export interface ContextExtractionRunRecord {
  id: string;
  sourceSetHash: string;
  extractorName: string;
  extractorVersion: string;
  promptVersion: string;
  status: 'processing' | 'completed' | 'failed';
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export class ContextSourceRepository {
  constructor(readonly client: Database.Database) {}

  saveSource(input: SaveContextSourceInput): { created: boolean; source: ContextSourceRecord } {
    const logicalKey = input.logicalKey.trim();
    const contentHash = sha256(input.contentText);
    const id = stableId('ctxsrc', `${logicalKey}\n${contentHash}`);
    return this.client.transaction(() => {
      const existing = this.findSourceByIdentity(logicalKey, contentHash);
      if (existing) return { created: false, source: existing };
      const row = this.client.prepare(`
        SELECT COALESCE(MAX(source_version), 0) + 1 AS next_version
        FROM context_sources WHERE logical_key = ?
      `).get(logicalKey) as { next_version: number };
      this.client.prepare(`
        INSERT INTO context_sources (
          id, source_system, source_type, external_id, logical_key, source_version,
          occurred_at, authors_json, locator_uri, content_format, content_text,
          metadata_json, content_hash, availability_status, captured_at,
          raw_text_expires_at, content_state, redacted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cleartext', NULL)
      `).run(id, input.sourceSystem, input.sourceType, input.externalId, logicalKey,
        row.next_version, input.occurredAt, canonicalJson(input.authors), input.locatorUri,
        input.contentFormat, input.contentText, canonicalJson(input.metadata), contentHash,
        input.availabilityStatus, input.capturedAt.toISOString(), input.rawTextExpiresAt?.toISOString() ?? null);
      return { created: true, source: this.getSourceOrThrow(id) };
    })();
  }

  saveEvidence(input: SaveEvidenceInput): { created: boolean; evidence: ContextEvidenceRecord } {
    const source = this.getSourceOrThrow(input.sourceId);
    if (source.contentState === 'redacted') throw new Error('CONTEXT_SOURCE_RAW_TEXT_REDACTED');
    const excerpt = input.excerpt.trim();
    const locator = validateContextEvidenceLocator(source, excerpt, input.locator);
    const locatorJson = canonicalJson(locator);
    const excerptHash = sha256(excerpt);
    if (locator.kind === 'minute_segment') {
      const { kind: _kind, ...legacyLocator } = locator;
      const legacy = this.findEvidence(source.id, excerptHash, canonicalJson(legacyLocator));
      if (legacy) return { created: false, evidence: legacy };
    }
    const id = stableId('ctxev', `${source.id}\n${locatorJson}\n${excerptHash}`);
    const result = this.client.prepare(`
      INSERT INTO context_evidence (
        id, source_id, source_version, excerpt, locator_json, excerpt_hash,
        evidence_level, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, excerpt_hash, locator_json) DO NOTHING
    `).run(id, source.id, source.sourceVersion, excerpt, locatorJson, excerptHash,
      input.evidenceLevel, input.capturedAt.toISOString());
    const row = result.changes === 1
      ? this.getEvidence(id)
      : this.findEvidence(source.id, excerptHash, locatorJson);
    if (!row) throw new Error('evidence insert could not be read back');
    return { created: result.changes === 1, evidence: row };
  }

  beginExtractionRun(input: BeginExtractionRunInput): { created: boolean; run: ContextExtractionRunRecord } {
    if (input.sources.length === 0) throw new Error('extraction run requires at least one source');
    const sorted = [...input.sources].sort((a, b) => a.id.localeCompare(b.id));
    for (const source of sorted) {
      const stored = this.getSourceOrThrow(source.id);
      if (stored.contentState === 'redacted') throw new Error('CONTEXT_SOURCE_RAW_TEXT_REDACTED');
      if (stored.contentHash !== source.contentHash) throw new Error('source content hash mismatch');
    }
    const sourceSetHash = sha256(canonicalJson(sorted));
    const identity = `${sourceSetHash}\n${input.extractorName}\n${input.extractorVersion}\n${input.promptVersion}`;
    const id = stableId('ctxrun', identity);
    return this.client.transaction(() => {
      const inserted = this.client.prepare(`
        INSERT INTO context_extraction_runs (
          id, source_set_hash, extractor_name, extractor_version, prompt_version,
          status, error_code, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'processing', NULL, ?, NULL)
        ON CONFLICT(source_set_hash, extractor_name, extractor_version, prompt_version) DO NOTHING
      `).run(id, sourceSetHash, input.extractorName, input.extractorVersion,
        input.promptVersion, input.startedAt.toISOString());
      const run = this.findExtractionRun(sourceSetHash, input.extractorName,
        input.extractorVersion, input.promptVersion);
      if (!run) throw new Error('extraction run insert could not be read back');
      if (inserted.changes === 1) {
        const insertSource = this.client.prepare(`
          INSERT INTO context_extraction_run_sources (extraction_run_id, source_id, source_role)
          VALUES (?, ?, ?)
        `);
        sorted.forEach((source, index) => insertSource.run(run.id, source.id, index === 0 ? 'primary' : 'context'));
      }
      return { created: inserted.changes === 1, run };
    })();
  }

  completeExtractionRun(runId: string, completedAt: Date): void {
    const result = this.client.prepare(`
      UPDATE context_extraction_runs SET status = 'completed', error_code = NULL, completed_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(completedAt.toISOString(), runId);
    if (result.changes !== 1) throw new Error('CONTEXT_EXTRACTION_RUN_TERMINAL_RACE');
  }

  failExtractionRun(runId: string, errorCode: string, failedAt: Date): void {
    const result = this.client.prepare(`
      UPDATE context_extraction_runs SET status = 'failed', error_code = ?, completed_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(errorCode, failedAt.toISOString(), runId);
    if (result.changes !== 1) throw new Error('CONTEXT_EXTRACTION_RUN_TERMINAL_RACE');
  }

  getRunSources(runId: string): ContextSourceRecord[] {
    const rows = this.client.prepare(`
      SELECT s.* FROM context_sources s
      INNER JOIN context_extraction_run_sources rs ON rs.source_id = s.id
      WHERE rs.extraction_run_id = ? ORDER BY rs.source_role DESC, s.id ASC
    `).all(runId) as SourceRow[];
    return rows.map(toSourceRecord);
  }

  markSourceAvailability(id: string, availability: ContextSourceAvailability): void {
    const result = this.client.prepare(`UPDATE context_sources SET availability_status = ? WHERE id = ?`)
      .run(availability, id);
    if (result.changes !== 1) throw new Error('context source not found');
  }

  getSource(id: string): ContextSourceRecord | null {
    const row = this.client.prepare('SELECT * FROM context_sources WHERE id = ?').get(id) as SourceRow | undefined;
    return row ? toSourceRecord(row) : null;
  }

  /** Every stored version of one logical source, oldest first. */
  listSourceVersions(logicalKey: string): ContextSourceRecord[] {
    return (this.client.prepare('SELECT * FROM context_sources WHERE logical_key = ? ORDER BY source_version')
      .all(logicalKey.trim()) as SourceRow[]).map(toSourceRecord);
  }

  /** Space page snapshots and comments of one page, ordered like listSources (later rows are newer versions). */
  listSpacePageSources(pageId: string): ContextSourceRecord[] {
    return (this.client.prepare(`SELECT * FROM context_sources
      WHERE source_type IN ('space_page_snapshot', 'space_page_comment') AND json_extract(metadata_json, '$.pageId') = ?
      ORDER BY logical_key, source_version`).all(pageId) as SourceRow[]).map(toSourceRecord);
  }

  listSources(): ContextSourceRecord[] {
    return (this.client.prepare('SELECT * FROM context_sources ORDER BY logical_key, source_version').all() as SourceRow[])
      .map(toSourceRecord);
  }

  previewExpiredRawText(input: { sourceIds: readonly string[]; asOf: Date }): ExpiredRawTextPreview[] {
    const ids = uniqueSourceIds(input.sourceIds);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.client.prepare(`
      SELECT id, source_type, raw_text_expires_at
      FROM context_sources
      WHERE id IN (${placeholders})
        AND content_state = 'cleartext'
        AND raw_text_expires_at IS NOT NULL
        AND raw_text_expires_at <= ?
      ORDER BY id
    `).all(...ids, input.asOf.toISOString()) as Array<{
      id: string; source_type: string; raw_text_expires_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id, sourceType: row.source_type, rawTextExpiresAt: row.raw_text_expires_at
    }));
  }

  redactExpiredRawText(input: {
    sourceIds: readonly string[];
    asOf: Date;
    redactedAt: Date;
  }): { redactedSourceIds: string[] } {
    if (input.sourceIds.length === 0 || new Set(input.sourceIds).size !== input.sourceIds.length) {
      throw new Error('CONTEXT_SOURCE_RETENTION_SOURCE_SET_INVALID');
    }
    const ids = [...input.sourceIds].sort();
    this.client.pragma('secure_delete = ON');
    return this.client.transaction(() => {
      const select = this.client.prepare(`
        SELECT id, raw_text_expires_at, content_state
        FROM context_sources WHERE id = ?
      `);
      for (const id of ids) {
        const row = select.get(id) as {
          id: string; raw_text_expires_at: string | null; content_state: ContextSourceContentState;
        } | undefined;
        if (!row) throw new Error('CONTEXT_SOURCE_RETENTION_SOURCE_NOT_FOUND');
        if (row.content_state !== 'cleartext' || row.raw_text_expires_at === null ||
          row.raw_text_expires_at > input.asOf.toISOString()) {
          throw new Error('CONTEXT_SOURCE_RETENTION_NOT_DUE');
        }
      }
      const requested = new Set(ids);
      const activeJobs = this.client.prepare(`
        SELECT payload FROM batch_jobs
        WHERE status IN ('queued', 'retry', 'processing')
          AND type IN ('capture_group_message', 'analyze_founder_stream_batch', 'extract_context_candidates')
      `).all() as Array<{ payload: string }>;
      for (const job of activeJobs) {
        let payload: { sourceIds?: unknown; sourceId?: unknown };
        try {
          payload = JSON.parse(job.payload) as { sourceIds?: unknown; sourceId?: unknown };
        } catch {
          throw new Error('CONTEXT_SOURCE_RETENTION_ACTIVE_USE');
        }
        const referenced = [
          ...(Array.isArray(payload.sourceIds) ? payload.sourceIds : []),
          payload.sourceId
        ];
        if (referenced.some((id) => typeof id === 'string' && requested.has(id))) {
          throw new Error('CONTEXT_SOURCE_RETENTION_ACTIVE_USE');
        }
      }
      const activeRun = this.client.prepare(`
        SELECT 1
        FROM context_extraction_run_sources rs
        INNER JOIN context_extraction_runs r ON r.id = rs.extraction_run_id
        WHERE r.status = 'processing' AND rs.source_id IN (${ids.map(() => '?').join(', ')})
        LIMIT 1
      `).get(...ids);
      if (activeRun) throw new Error('CONTEXT_SOURCE_RETENTION_ACTIVE_USE');
      const update = this.client.prepare(`
        UPDATE context_sources
        SET content_text = ?, content_state = 'redacted', redacted_at = ?
        WHERE id = ? AND content_state = 'cleartext'
      `);
      for (const id of ids) {
        const evidenceRows = this.client.prepare(`
          SELECT id FROM context_evidence WHERE source_id = ? ORDER BY id
        `).all(id) as Array<{ id: string }>;
        const redactEvidence = this.client.prepare(`
          UPDATE context_evidence SET excerpt = ?, excerpt_hash = ? WHERE id = ?
        `);
        for (const evidence of evidenceRows) {
          const excerpt = `[REDACTED:RETENTION_EXPIRED:${evidence.id}]`;
          redactEvidence.run(excerpt, sha256(excerpt), evidence.id);
        }
        const result = update.run(retentionRedactionPlaceholder, input.redactedAt.toISOString(), id);
        if (result.changes !== 1) throw new Error('CONTEXT_SOURCE_RETENTION_WRITE_CONFLICT');
      }
      return { redactedSourceIds: ids };
    })();
  }

  getEvidence(id: string): ContextEvidenceRecord | null {
    const row = this.client.prepare('SELECT * FROM context_evidence WHERE id = ?').get(id) as EvidenceRow | undefined;
    return row ? toEvidenceRecord(row) : null;
  }

  private getSourceOrThrow(id: string): ContextSourceRecord {
    const source = this.getSource(id);
    if (!source) throw new Error('context source not found');
    return source;
  }

  private findSourceByIdentity(logicalKey: string, contentHash: string): ContextSourceRecord | null {
    const row = this.client.prepare('SELECT * FROM context_sources WHERE logical_key = ? AND content_hash = ?')
      .get(logicalKey, contentHash) as SourceRow | undefined;
    return row ? toSourceRecord(row) : null;
  }

  private findEvidence(sourceId: string, excerptHash: string, locatorJson: string): ContextEvidenceRecord | null {
    const row = this.client.prepare('SELECT * FROM context_evidence WHERE source_id = ? AND excerpt_hash = ? AND locator_json = ?')
      .get(sourceId, excerptHash, locatorJson) as EvidenceRow | undefined;
    return row ? toEvidenceRecord(row) : null;
  }

  private findExtractionRun(sourceSetHash: string, extractorName: string, extractorVersion: string, promptVersion: string): ContextExtractionRunRecord | null {
    const row = this.client.prepare(`SELECT * FROM context_extraction_runs WHERE source_set_hash = ? AND extractor_name = ? AND extractor_version = ? AND prompt_version = ?`)
      .get(sourceSetHash, extractorName, extractorVersion, promptVersion) as RunRow | undefined;
    return row ? toRunRecord(row) : null;
  }
}

interface SourceRow { id: string; source_system: string; source_type: string; external_id: string; logical_key: string; source_version: number; occurred_at: string; authors_json: string; locator_uri: string | null; content_format: string; content_text: string; metadata_json: string; content_hash: string; availability_status: ContextSourceAvailability; captured_at: string; raw_text_expires_at: string | null; content_state: ContextSourceContentState; redacted_at: string | null }
interface EvidenceRow { id: string; source_id: string; source_version: number; excerpt: string; locator_json: string; excerpt_hash: string; evidence_level: ContextEvidenceLevel; captured_at: string }
interface RunRow { id: string; source_set_hash: string; extractor_name: string; extractor_version: string; prompt_version: string; status: ContextExtractionRunRecord['status']; error_code: string | null; started_at: string; completed_at: string | null }

function toSourceRecord(row: SourceRow): ContextSourceRecord { return { id: row.id, sourceSystem: row.source_system, sourceType: row.source_type, externalId: row.external_id, logicalKey: row.logical_key, sourceVersion: row.source_version, occurredAt: row.occurred_at, authors: JSON.parse(row.authors_json) as Record<string, unknown>[], locatorUri: row.locator_uri, contentFormat: row.content_format, contentText: row.content_text, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, contentHash: row.content_hash, availabilityStatus: row.availability_status, capturedAt: row.captured_at, rawTextExpiresAt: row.raw_text_expires_at, contentState: row.content_state, redactedAt: row.redacted_at }; }

function uniqueSourceIds(sourceIds: readonly string[]): string[] {
  return [...new Set(sourceIds)].sort();
}
function toEvidenceRecord(row: EvidenceRow): ContextEvidenceRecord { return { id: row.id, sourceId: row.source_id, sourceVersion: row.source_version, excerpt: row.excerpt, locator: contextEvidenceLocatorSchema.parse(JSON.parse(row.locator_json)), excerptHash: row.excerpt_hash, evidenceLevel: row.evidence_level, capturedAt: row.captured_at }; }
function toRunRecord(row: RunRow): ContextExtractionRunRecord { return { id: row.id, sourceSetHash: row.source_set_hash, extractorName: row.extractor_name, extractorVersion: row.extractor_version, promptVersion: row.prompt_version, status: row.status, errorCode: row.error_code, startedAt: row.started_at, completedAt: row.completed_at }; }
