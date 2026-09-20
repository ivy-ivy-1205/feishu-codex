import type Database from 'better-sqlite3';
import {
  founderRoleSchema,
  perspectiveKindSchema,
  perspectiveSpeechActSchema,
  type CurrentPerspective,
  type FounderIdentity,
  type FounderRole,
  type PerspectiveKind,
  type PerspectiveSpeechAct,
  type PerspectiveVersion
} from '../domain/alignment.js';
import { stableId } from '../services/canonical-json.js';

export interface ConfigureFounderIdentityInput {
  founder: FounderRole;
  sourceSystem: string;
  externalAuthorId: string;
  configuredAt: Date;
}

export interface SavePerspectiveInput {
  topicId: string;
  kind: PerspectiveKind;
  expectedVersion: number;
  statement: string;
  confidence: number;
  evidenceIds: readonly string[];
  decisionKey?: string | null;
  speechAct: PerspectiveSpeechAct;
  observedAt: Date;
}

export class PerspectiveVersionConflictError extends Error {
  readonly code = 'PERSPECTIVE_VERSION_CONFLICT';

  constructor(detail?: string) {
    super(detail ? `PERSPECTIVE_VERSION_CONFLICT: ${detail}` : 'PERSPECTIVE_VERSION_CONFLICT');
    this.name = 'PerspectiveVersionConflictError';
  }
}

export class FounderIdentityConflictError extends Error {
  readonly code = 'FOUNDER_IDENTITY_CONFLICT';

  constructor() {
    super('FOUNDER_IDENTITY_CONFLICT');
    this.name = 'FounderIdentityConflictError';
  }
}

export class AlignmentRepository {
  constructor(readonly client: Database.Database) {}

  runInTransaction<T>(operation: () => T): T {
    if (this.client.inTransaction) return operation();
    try {
      return this.client.transaction(operation).immediate();
    } catch (error) {
      if (isSqliteBusyError(error)) throw new PerspectiveVersionConflictError();
      throw error;
    }
  }

  configureFounderIdentity(input: ConfigureFounderIdentityInput): FounderIdentity {
    const founder = founderRoleSchema.parse(input.founder);
    const sourceSystem = requiredText(input.sourceSystem, 'source system');
    const externalAuthorId = requiredText(input.externalAuthorId, 'external author id');
    const configuredAt = input.configuredAt.toISOString();
    const id = stableId('founder', `${sourceSystem}\n${externalAuthorId}`);
    return this.client.transaction(() => {
      this.client.prepare(`
        INSERT INTO founder_identities (
          id, founder, source_system, external_author_id, configured_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_system, external_author_id) DO NOTHING
      `).run(id, founder, sourceSystem, externalAuthorId, configuredAt);
      const identity = this.findFounderIdentity(sourceSystem, externalAuthorId);
      if (!identity) throw new Error('founder identity could not be read back');
      if (identity.founder !== founder) throw new FounderIdentityConflictError();
      return identity;
    })();
  }

  resolveFounderForEvidence(evidenceId: string): FounderRole | null {
    const row = this.client.prepare(`
      SELECT s.source_system, s.source_type, s.authors_json
      FROM context_evidence e
      INNER JOIN context_sources s ON s.id = e.source_id
      WHERE e.id = ?
    `).get(evidenceId) as EvidenceAuthorRow | undefined;
    if (!row || row.source_type !== 'group_message') return null;
    const externalAuthorId = singleAuthorOpenId(row.authors_json);
    if (!externalAuthorId) return null;
    return this.findFounderIdentity(row.source_system, externalAuthorId)?.founder ?? null;
  }

  savePerspective(input: SavePerspectiveInput): PerspectiveVersion {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new PerspectiveVersionConflictError('expectedVersion must be a non-negative integer');
    }
    const topicId = requiredText(input.topicId, 'topic id');
    const kind = perspectiveKindSchema.parse(input.kind);
    const statement = requiredText(input.statement, 'perspective statement');
    const confidence = input.confidence;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('perspective confidence must be between 0 and 1');
    }
    const evidenceIds = uniqueRequiredIds(input.evidenceIds);
    if (evidenceIds.length === 0) throw new Error('perspective evidence is required');
    const decisionKey = optionalText(input.decisionKey);
    const speechAct = perspectiveSpeechActSchema.parse(input.speechAct);
    const observedAt = input.observedAt.toISOString();
    const perspectiveId = stableId('perspective', `${topicId}\n${kind}`);

    const save = this.client.transaction(() => {
      const current = this.client.prepare(`
        SELECT current_version FROM topic_perspectives WHERE id = ?
      `).get(perspectiveId) as { current_version: number } | undefined;
      const currentVersion = current?.current_version ?? 0;
      if (currentVersion !== input.expectedVersion) throw new PerspectiveVersionConflictError();
      this.assertTopicExists(topicId);
      this.assertEvidenceGroundsStatement(evidenceIds, statement);

      const nextVersion = currentVersion + 1;
      const versionId = stableId('perspectivever', `${perspectiveId}\n${nextVersion}`);
      if (!current) {
        this.client.prepare(`
          INSERT INTO topic_perspectives (
            id, topic_id, kind, current_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(perspectiveId, topicId, kind, nextVersion, observedAt, observedAt);
      }
      this.client.prepare(`
        INSERT INTO topic_perspective_versions (
          id, perspective_id, version_number, statement, confidence,
          evidence_ids_json, decision_key, speech_act, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, perspectiveId, nextVersion, statement, confidence,
        JSON.stringify(evidenceIds), decisionKey, speechAct, observedAt);
      if (current) {
        const updated = this.client.prepare(`
          UPDATE topic_perspectives SET current_version = ?, updated_at = ?
          WHERE id = ? AND current_version = ?
        `).run(nextVersion, observedAt, perspectiveId, currentVersion);
        if (updated.changes !== 1) throw new PerspectiveVersionConflictError();
      }
      return this.getVersionOrThrow(topicId, kind, nextVersion);
    });
    try {
      return this.client.inTransaction ? save() : save.immediate();
    } catch (error) {
      if (isSqliteBusyError(error)) throw new PerspectiveVersionConflictError();
      throw error;
    }
  }

  getCurrentPerspective(topicId: string, kind: PerspectiveKind): CurrentPerspective | null {
    const row = this.client.prepare(`
      SELECT p.topic_id, p.kind, p.created_at, p.updated_at,
        v.id, v.perspective_id, v.version_number, v.statement, v.confidence,
        v.evidence_ids_json, v.decision_key, v.speech_act, v.observed_at
      FROM topic_perspectives p
      INNER JOIN topic_perspective_versions v
        ON v.perspective_id = p.id AND v.version_number = p.current_version
      WHERE p.topic_id = ? AND p.kind = ?
    `).get(topicId, perspectiveKindSchema.parse(kind)) as CurrentPerspectiveRow | undefined;
    return row ? toCurrentPerspective(row) : null;
  }

  listCurrentPerspectives(topicId: string): CurrentPerspective[] {
    return (this.client.prepare(`
      SELECT p.topic_id, p.kind, p.created_at, p.updated_at,
        v.id, v.perspective_id, v.version_number, v.statement, v.confidence,
        v.evidence_ids_json, v.decision_key, v.speech_act, v.observed_at
      FROM topic_perspectives p
      INNER JOIN topic_perspective_versions v
        ON v.perspective_id = p.id AND v.version_number = p.current_version
      WHERE p.topic_id = ? ORDER BY p.kind
    `).all(topicId) as CurrentPerspectiveRow[]).map(toCurrentPerspective);
  }

  listPerspectiveVersions(topicId: string, kind: PerspectiveKind): PerspectiveVersion[] {
    return (this.client.prepare(`
      SELECT p.topic_id, p.kind, v.*
      FROM topic_perspectives p
      INNER JOIN topic_perspective_versions v ON v.perspective_id = p.id
      WHERE p.topic_id = ? AND p.kind = ? ORDER BY v.version_number
    `).all(topicId, perspectiveKindSchema.parse(kind)) as PerspectiveVersionRow[])
      .map(toPerspectiveVersion);
  }

  private findFounderIdentity(sourceSystem: string, externalAuthorId: string): FounderIdentity | null {
    const row = this.client.prepare(`
      SELECT * FROM founder_identities
      WHERE source_system = ? AND external_author_id = ?
    `).get(sourceSystem, externalAuthorId) as FounderIdentityRow | undefined;
    return row ? {
      id: row.id,
      founder: founderRoleSchema.parse(row.founder),
      sourceSystem: row.source_system,
      externalAuthorId: row.external_author_id,
      configuredAt: row.configured_at
    } : null;
  }

  private assertTopicExists(topicId: string): void {
    if (!this.client.prepare('SELECT id FROM context_topics WHERE id = ?').get(topicId)) {
      throw new Error(`topic not found: ${topicId}`);
    }
  }

  private assertEvidenceGroundsStatement(evidenceIds: readonly string[], statement: string): void {
    const find = this.client.prepare('SELECT excerpt FROM context_evidence WHERE id = ?');
    let grounded = false;
    for (const evidenceId of evidenceIds) {
      const evidence = find.get(evidenceId) as { excerpt: string } | undefined;
      if (!evidence) throw new Error(`perspective evidence not found: ${evidenceId}`);
      if (evidence.excerpt.includes(statement)) grounded = true;
    }
    if (!grounded) throw new Error('perspective statement is not grounded in supplied evidence');
  }

  private getVersionOrThrow(
    topicId: string,
    kind: PerspectiveKind,
    versionNumber: number
  ): PerspectiveVersion {
    const row = this.client.prepare(`
      SELECT p.topic_id, p.kind, v.*
      FROM topic_perspectives p
      INNER JOIN topic_perspective_versions v ON v.perspective_id = p.id
      WHERE p.topic_id = ? AND p.kind = ? AND v.version_number = ?
    `).get(topicId, kind, versionNumber) as PerspectiveVersionRow | undefined;
    if (!row) throw new Error('perspective version could not be read back');
    return toPerspectiveVersion(row);
  }
}

interface FounderIdentityRow {
  id: string;
  founder: FounderRole;
  source_system: string;
  external_author_id: string;
  configured_at: string;
}
interface EvidenceAuthorRow { source_system: string; source_type: string; authors_json: string }
interface PerspectiveVersionRow {
  id: string;
  perspective_id: string;
  topic_id: string;
  kind: PerspectiveKind;
  version_number: number;
  statement: string;
  confidence: number;
  evidence_ids_json: string;
  decision_key: string | null;
  speech_act: PerspectiveSpeechAct;
  observed_at: string;
}
interface CurrentPerspectiveRow extends PerspectiveVersionRow {
  created_at: string;
  updated_at: string;
}

function toPerspectiveVersion(row: PerspectiveVersionRow): PerspectiveVersion {
  return {
    id: row.id,
    perspectiveId: row.perspective_id,
    topicId: row.topic_id,
    kind: perspectiveKindSchema.parse(row.kind),
    versionNumber: row.version_number,
    statement: row.statement,
    confidence: row.confidence,
    evidenceIds: parseEvidenceIds(row.evidence_ids_json),
    decisionKey: row.decision_key,
    speechAct: perspectiveSpeechActSchema.parse(row.speech_act),
    observedAt: row.observed_at
  };
}

function toCurrentPerspective(row: CurrentPerspectiveRow): CurrentPerspective {
  return { ...toPerspectiveVersion(row), createdAt: row.created_at, updatedAt: row.updated_at };
}

function parseEvidenceIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('stored perspective evidence ids are invalid');
  }
  return parsed;
}

function singleAuthorOpenId(authorsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authorsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  const author = parsed[0];
  if (!author || typeof author !== 'object' || !('openId' in author)) return null;
  return typeof author.openId === 'string' && author.openId.trim() ? author.openId.trim() : null;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function uniqueRequiredIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => requiredText(id, 'evidence id')))];
}

function isSqliteBusyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('SQLITE_BUSY'));
}
