import type Database from 'better-sqlite3';
import {
  topicRelationTypeSchema,
  topicStageSchema,
  type CurrentTopic,
  type TopicRelation,
  type TopicRelationType,
  type TopicSourceLink,
  type TopicStage,
  type TopicVersion
} from '../domain/topic.js';
import { stableId } from '../services/canonical-json.js';

export interface CreateTopicInput {
  displayName: string;
  stage: TopicStage;
  outcome?: string | null;
  rationale?: string;
  evidenceIds?: readonly string[];
  createdAt: Date;
}

export interface AppendTopicVersionInput {
  topicId: string;
  expectedVersion: number;
  displayName: string;
  stage: TopicStage;
  outcome: string | null;
  rationale: string;
  evidenceIds: readonly string[];
  changedAt: Date;
}

export interface AddTopicSourceInput {
  topicId: string;
  sourceId: string;
  evidenceId?: string | null;
  versionNumber?: number;
  addedAt: Date;
}

export interface AddTopicRelationInput {
  fromTopicId: string;
  toTopicId: string;
  relationType: TopicRelationType;
  rationale: string;
  createdAt: Date;
}

export class TopicVersionConflictError extends Error {
  readonly code = 'TOPIC_VERSION_CONFLICT';

  constructor(detail?: string) {
    super(detail ? `TOPIC_VERSION_CONFLICT: ${detail}` : 'TOPIC_VERSION_CONFLICT');
    this.name = 'TopicVersionConflictError';
  }
}

export class TopicRepository {
  constructor(readonly client: Database.Database) {}

  createTopic(input: CreateTopicInput): CurrentTopic {
    const displayName = requiredText(input.displayName, 'topic display name');
    const stage = topicStageSchema.parse(input.stage);
    const createdAt = input.createdAt.toISOString();
    const evidenceIds = uniqueIds(input.evidenceIds ?? []);
    const topicId = stableId('topic', `${createdAt}\n${displayName}`);
    const versionId = topicVersionId(topicId, 1);

    this.client.transaction(() => {
      this.assertEvidenceExists(evidenceIds);
      this.client.prepare(`
        INSERT INTO context_topics (id, current_version, created_at, updated_at)
        VALUES (?, 1, ?, ?)
      `).run(topicId, createdAt, createdAt);
      this.insertVersion({
        id: versionId,
        topicId,
        versionNumber: 1,
        displayName,
        stage,
        outcome: nullableText(input.outcome),
        rationale: input.rationale?.trim() ?? '',
        evidenceIds,
        changedAt: createdAt
      });
      this.linkEvidenceSources(topicId, 1, evidenceIds, createdAt);
    })();

    return this.getCurrentTopicOrThrow(topicId);
  }

  appendVersion(input: AppendTopicVersionInput): TopicVersion {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new TopicVersionConflictError('expectedVersion must be a positive integer');
    }
    const displayName = requiredText(input.displayName, 'topic display name');
    const stage = topicStageSchema.parse(input.stage);
    const evidenceIds = uniqueIds(input.evidenceIds);
    const changedAt = input.changedAt.toISOString();
    const nextVersion = input.expectedVersion + 1;
    const versionId = topicVersionId(input.topicId, nextVersion);

    const append = this.client.transaction(() => {
      const current = this.client.prepare(`
        SELECT current_version FROM context_topics WHERE id = ?
      `).get(input.topicId) as { current_version: number } | undefined;
      if (!current || current.current_version !== input.expectedVersion) {
        throw new TopicVersionConflictError();
      }
      this.assertEvidenceExists(evidenceIds);
      this.insertVersion({
        id: versionId,
        topicId: input.topicId,
        versionNumber: nextVersion,
        displayName,
        stage,
        outcome: nullableText(input.outcome),
        rationale: input.rationale.trim(),
        evidenceIds,
        changedAt
      });
      this.linkEvidenceSources(input.topicId, nextVersion, evidenceIds, changedAt);
      const updated = this.client.prepare(`
        UPDATE context_topics
        SET current_version = ?, updated_at = ?
        WHERE id = ? AND current_version = ?
      `).run(nextVersion, changedAt, input.topicId, input.expectedVersion);
      if (updated.changes !== 1) throw new TopicVersionConflictError();
      return this.getVersionOrThrow(input.topicId, nextVersion);
    });
    try {
      return append.immediate();
    } catch (error) {
      if (isSqliteBusyError(error)) throw new TopicVersionConflictError();
      throw error;
    }
  }

  addSource(input: AddTopicSourceInput): TopicSourceLink {
    return this.client.transaction(() => {
      const topic = this.getCurrentTopicOrThrow(input.topicId);
      const versionNumber = input.versionNumber ?? topic.currentVersion;
      const version = this.getVersionOrThrow(input.topicId, versionNumber);
      const evidenceId = input.evidenceId ?? null;
      this.assertSourceEvidencePair(input.sourceId, evidenceId);
      return this.insertSourceLink(
        input.topicId,
        version.id,
        versionNumber,
        input.sourceId,
        evidenceId,
        input.addedAt.toISOString()
      );
    })();
  }

  addRelation(input: AddTopicRelationInput): TopicRelation {
    const relationType = topicRelationTypeSchema.parse(input.relationType);
    if (input.fromTopicId === input.toTopicId) throw new Error('topic relation requires distinct topics');
    const [fromTopicId, toTopicId] = canonicalRelationEndpoints(
      input.fromTopicId,
      input.toTopicId,
      relationType
    );
    const id = stableId('topicrel', `${fromTopicId}\n${toTopicId}\n${relationType}`);

    return this.client.transaction(() => {
      const from = this.getCurrentTopicOrThrow(fromTopicId);
      const to = this.getCurrentTopicOrThrow(toTopicId);
      this.client.prepare(`
        INSERT INTO context_topic_relations (
          id, from_topic_id, from_topic_version_id, to_topic_id, to_topic_version_id,
          relation_type, rationale, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        id,
        fromTopicId,
        topicVersionId(fromTopicId, from.currentVersion),
        toTopicId,
        topicVersionId(toTopicId, to.currentVersion),
        relationType,
        input.rationale.trim(),
        input.createdAt.toISOString()
      );
      return this.getRelationOrThrow(id);
    })();
  }

  listCurrentTopics(): CurrentTopic[] {
    const rows = this.client.prepare(`
      SELECT t.id AS topic_id, t.current_version, t.created_at, t.updated_at,
        v.id AS version_id, v.version_number, v.display_name, v.stage, v.outcome,
        v.rationale, v.evidence_ids_json, v.changed_at
      FROM context_topics t
      INNER JOIN context_topic_versions v
        ON v.topic_id = t.id AND v.version_number = t.current_version
      ORDER BY t.created_at ASC, t.id ASC
    `).all() as CurrentTopicRow[];
    return rows.map(toCurrentTopic);
  }

  /**
   * Collapse only explicit same_as components; directional part_of relations remain visible. The oldest member stands
   * for the group, except that a member a founder registered to a project (its Space page, its line) always does
   * (2026-10-30: the hidden 「56 Bonnefin这个项目」 predates the registered 「56 Bonnefin 楼花展示项目总览」).
   */
  listCanonicalTopics(): CurrentTopic[] {
    const topics = this.listCurrentTopics();
    const registered = new Set((this.client.prepare(`SELECT topic_id FROM founder_topic_project_bindings
      WHERE role = 'canonical' AND source <> 'analysis'`).all() as { topic_id: string }[]).map((row) => row.topic_id));
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    const parent = new Map(topics.map((topic) => [topic.id, topic.id]));
    const find = (id: string): string => {
      const current = parent.get(id)!;
      if (current === id) return id;
      const root = find(current); parent.set(id, root); return root;
    };
    const join = (left: string, right: string) => {
      const a = find(left), b = find(right);
      if (a === b) return;
      const first = byId.get(a)!, second = byId.get(b)!;
      const canonical = registered.has(a) !== registered.has(b) ? (registered.has(a) ? a : b)
        : first.createdAt.localeCompare(second.createdAt) <= 0 ? a : b;
      parent.set(canonical === a ? b : a, canonical);
    };
    for (const relation of this.listRelations()) {
      if (relation.relationType === 'same_as' && byId.has(relation.fromTopicId) && byId.has(relation.toTopicId)) {
        join(relation.fromTopicId, relation.toTopicId);
      }
    }
    const components = new Map<string, CurrentTopic[]>();
    for (const topic of topics) {
      const root = find(topic.id);
      components.set(root, [...(components.get(root) ?? []), topic]);
    }
    return topics.filter((topic) => find(topic.id) === topic.id).map((canonical) => {
      const component = components.get(canonical.id) ?? [canonical];
      return { ...canonical, evidenceIds: [...new Set(component.flatMap((topic) => topic.evidenceIds))] };
    });
  }

  listVersions(topicId: string): TopicVersion[] {
    return (this.client.prepare(`
      SELECT * FROM context_topic_versions
      WHERE topic_id = ? ORDER BY version_number ASC
    `).all(topicId) as TopicVersionRow[]).map(toTopicVersion);
  }

  listRelations(topicId?: string): TopicRelation[] {
    const rows = topicId
      ? this.client.prepare(`
          SELECT r.*, fv.version_number AS from_version_number,
            tv.version_number AS to_version_number
          FROM context_topic_relations r
          INNER JOIN context_topic_versions fv ON fv.id = r.from_topic_version_id
          INNER JOIN context_topic_versions tv ON tv.id = r.to_topic_version_id
          WHERE r.from_topic_id = ? OR r.to_topic_id = ?
          ORDER BY r.created_at, r.id
        `).all(topicId, topicId)
      : this.client.prepare(`
          SELECT r.*, fv.version_number AS from_version_number,
            tv.version_number AS to_version_number
          FROM context_topic_relations r
          INNER JOIN context_topic_versions fv ON fv.id = r.from_topic_version_id
          INNER JOIN context_topic_versions tv ON tv.id = r.to_topic_version_id
          ORDER BY r.created_at, r.id
        `).all();
    return (rows as TopicRelationRow[]).map(toTopicRelation);
  }

  private insertVersion(version: TopicVersion): void {
    this.client.prepare(`
      INSERT INTO context_topic_versions (
        id, topic_id, version_number, display_name, stage, outcome, rationale,
        evidence_ids_json, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.id,
      version.topicId,
      version.versionNumber,
      version.displayName,
      version.stage,
      version.outcome,
      version.rationale,
      JSON.stringify(version.evidenceIds),
      version.changedAt
    );
  }

  private linkEvidenceSources(
    topicId: string,
    versionNumber: number,
    evidenceIds: readonly string[],
    addedAt: string
  ): void {
    if (evidenceIds.length === 0) return;
    const findEvidence = this.client.prepare('SELECT source_id FROM context_evidence WHERE id = ?');
    for (const evidenceId of evidenceIds) {
      const evidence = findEvidence.get(evidenceId) as { source_id: string };
      this.insertSourceLink(
        topicId,
        topicVersionId(topicId, versionNumber),
        versionNumber,
        evidence.source_id,
        evidenceId,
        addedAt
      );
    }
  }

  private insertSourceLink(
    topicId: string,
    versionId: string,
    versionNumber: number,
    sourceId: string,
    evidenceId: string | null,
    addedAt: string
  ): TopicSourceLink {
    const id = stableId('topicsrc', `${versionId}\n${sourceId}\n${evidenceId ?? ''}`);
    this.client.prepare(`
      INSERT INTO context_topic_sources (
        id, topic_version_id, source_id, evidence_id, added_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(id, versionId, sourceId, evidenceId, addedAt);
    const row = this.client.prepare(`
      SELECT * FROM context_topic_sources WHERE id = ?
    `).get(id) as TopicSourceRow | undefined;
    if (!row) throw new Error('topic source link could not be read back');
    return {
      id: row.id,
      topicId,
      topicVersion: versionNumber,
      sourceId: row.source_id,
      evidenceId: row.evidence_id,
      addedAt: row.added_at
    };
  }

  private assertEvidenceExists(evidenceIds: readonly string[]): void {
    const statement = this.client.prepare('SELECT id FROM context_evidence WHERE id = ?');
    for (const evidenceId of evidenceIds) {
      if (!statement.get(evidenceId)) throw new Error(`topic evidence not found: ${evidenceId}`);
    }
  }

  private assertSourceEvidencePair(sourceId: string, evidenceId: string | null): void {
    if (!evidenceId) {
      if (!this.client.prepare('SELECT id FROM context_sources WHERE id = ?').get(sourceId)) {
        throw new Error(`topic source not found: ${sourceId}`);
      }
      return;
    }
    const evidence = this.client.prepare(`
      SELECT source_id FROM context_evidence WHERE id = ?
    `).get(evidenceId) as { source_id: string } | undefined;
    if (!evidence || evidence.source_id !== sourceId) {
      throw new Error('topic evidence does not belong to source');
    }
  }

  private getCurrentTopicOrThrow(topicId: string): CurrentTopic {
    const row = this.client.prepare(`
      SELECT t.id AS topic_id, t.current_version, t.created_at, t.updated_at,
        v.id AS version_id, v.version_number, v.display_name, v.stage, v.outcome,
        v.rationale, v.evidence_ids_json, v.changed_at
      FROM context_topics t
      INNER JOIN context_topic_versions v
        ON v.topic_id = t.id AND v.version_number = t.current_version
      WHERE t.id = ?
    `).get(topicId) as CurrentTopicRow | undefined;
    if (!row) throw new Error(`topic not found: ${topicId}`);
    return toCurrentTopic(row);
  }

  private getVersionOrThrow(topicId: string, versionNumber: number): TopicVersion {
    const row = this.client.prepare(`
      SELECT * FROM context_topic_versions WHERE topic_id = ? AND version_number = ?
    `).get(topicId, versionNumber) as TopicVersionRow | undefined;
    if (!row) throw new Error(`topic version not found: ${topicId}@${versionNumber}`);
    return toTopicVersion(row);
  }

  private getRelationOrThrow(id: string): TopicRelation {
    const row = this.client.prepare(`
      SELECT r.*, fv.version_number AS from_version_number,
        tv.version_number AS to_version_number
      FROM context_topic_relations r
      INNER JOIN context_topic_versions fv ON fv.id = r.from_topic_version_id
      INNER JOIN context_topic_versions tv ON tv.id = r.to_topic_version_id
      WHERE r.id = ?
    `).get(id) as TopicRelationRow | undefined;
    if (!row) throw new Error('topic relation could not be read back');
    return toTopicRelation(row);
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => requiredText(id, 'evidence id')))];
}

function isSqliteBusyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_BUSY')
  );
}

function topicVersionId(topicId: string, versionNumber: number): string {
  return stableId('topicver', `${topicId}\n${versionNumber}`);
}

function canonicalRelationEndpoints(
  fromTopicId: string,
  toTopicId: string,
  relationType: TopicRelationType
): [string, string] {
  if (relationType !== 'same_as' && relationType !== 'related_to') {
    return [fromTopicId, toTopicId];
  }
  return fromTopicId.localeCompare(toTopicId) <= 0
    ? [fromTopicId, toTopicId]
    : [toTopicId, fromTopicId];
}

interface TopicVersionRow {
  id: string;
  topic_id: string;
  version_number: number;
  display_name: string;
  stage: TopicStage;
  outcome: string | null;
  rationale: string;
  evidence_ids_json: string;
  changed_at: string;
}

interface CurrentTopicRow {
  topic_id: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  version_id: string;
  version_number: number;
  display_name: string;
  stage: TopicStage;
  outcome: string | null;
  rationale: string;
  evidence_ids_json: string;
  changed_at: string;
}

interface TopicSourceRow {
  id: string;
  topic_version_id: string;
  source_id: string;
  evidence_id: string | null;
  added_at: string;
}

interface TopicRelationRow {
  id: string;
  from_topic_id: string;
  from_version_number: number;
  to_topic_id: string;
  to_version_number: number;
  relation_type: TopicRelationType;
  rationale: string;
  created_at: string;
}

function toTopicVersion(row: TopicVersionRow): TopicVersion {
  return {
    id: row.id,
    topicId: row.topic_id,
    versionNumber: row.version_number,
    displayName: row.display_name,
    stage: topicStageSchema.parse(row.stage),
    outcome: row.outcome,
    rationale: row.rationale,
    evidenceIds: parseEvidenceIds(row.evidence_ids_json),
    changedAt: row.changed_at
  };
}

function toCurrentTopic(row: CurrentTopicRow): CurrentTopic {
  return {
    id: row.topic_id,
    currentVersionId: row.version_id,
    currentVersion: row.current_version,
    displayName: row.display_name,
    stage: topicStageSchema.parse(row.stage),
    outcome: row.outcome,
    rationale: row.rationale,
    evidenceIds: parseEvidenceIds(row.evidence_ids_json),
    changedAt: row.changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTopicRelation(row: TopicRelationRow): TopicRelation {
  return {
    id: row.id,
    fromTopicId: row.from_topic_id,
    fromVersionNumber: row.from_version_number,
    toTopicId: row.to_topic_id,
    toVersionNumber: row.to_version_number,
    relationType: topicRelationTypeSchema.parse(row.relation_type),
    rationale: row.rationale,
    createdAt: row.created_at
  };
}

function parseEvidenceIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('topic evidence list is invalid');
  }
  return parsed;
}
