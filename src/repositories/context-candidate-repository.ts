import type Database from 'better-sqlite3';
import type {
  ContextCandidateType, ContextEvidenceRole, ContextFactualStatus,
  ContextProjectConfidence, ContextProjectMappingStatus, ContextProjectRole,
  ContextRelationType, ContextReviewStatus, ContextScope
} from '../domain/context.js';
import { initialFactualStatusFor } from '../domain/context.js';
import { canonicalJson, sha256, stableId } from '../services/canonical-json.js';

export interface CandidateProjectInput {
  projectKey: string | null;
  role: ContextProjectRole;
  mappingStatus: ContextProjectMappingStatus;
  confidence: ContextProjectConfidence;
  evidence: string;
}
export interface CandidateEvidenceInput { evidenceId: string; role: ContextEvidenceRole }
export interface CandidateRecordRelationInput { recordId: string; relationType: ContextRelationType; rationale: string }
export interface SaveContextCandidateInput {
  extractionRunId: string;
  candidateType: ContextCandidateType;
  scope: ContextScope;
  summary: string;
  subjectKey: string | null;
  structuredPayload: Record<string, unknown>;
  extractionConfidence: number;
  factualStatus: 'source_attested' | 'reported';
  projects: readonly CandidateProjectInput[];
  evidence: readonly CandidateEvidenceInput[];
  suggestedRelations: readonly CandidateRecordRelationInput[];
  externalRefs: readonly Record<string, unknown>[];
}

export interface ContextCandidateRecord {
  id: string;
  extractionRunId: string;
  candidateType: ContextCandidateType;
  scope: ContextScope;
  summary: string;
  subjectKey: string | null;
  structuredPayload: Record<string, unknown>;
  extractionConfidence: number;
  factualStatus: ContextFactualStatus;
  reviewStatus: ContextReviewStatus;
  candidateFingerprint: string;
  externalRefs: readonly Record<string, unknown>[];
  projects: Array<CandidateProjectInput>;
  evidence: Array<CandidateEvidenceInput & { excerpt: string; sourceId: string; sourceVersion: number;
    sourceOccurredAt: string; evidenceLevel: 'derived_summary' | 'primary_statement' | 'authoritative_record' | 'direct_observation' }>;
  suggestedRelations: CandidateRecordRelationInput[];
  createdAt: string;
  updatedAt: string;
}

export class ContextCandidateRepository {
  constructor(readonly client: Database.Database) {}

  saveCandidate(input: SaveContextCandidateInput): { created: boolean; candidate: ContextCandidateRecord } {
    if (!input.evidence.some((item) => item.role === 'supporting')) {
      throw new Error('context candidate requires supporting evidence');
    }
    if (input.extractionConfidence < 0 || input.extractionConfidence > 1) {
      throw new Error('extraction confidence must be between 0 and 1');
    }
    if (input.factualStatus !== initialFactualStatusFor(input.candidateType)) {
      throw new Error('candidate type and initial factual status do not match');
    }
    this.assertEvidenceBelongsToRun(input.extractionRunId, input.evidence.map((item) => item.evidenceId));
    const fingerprint = sha256(canonicalJson({
      sourceRun: input.extractionRunId,
      type: input.candidateType,
      scope: input.scope,
      summary: normalizeText(input.summary),
      subjectKey: input.subjectKey?.trim() || null,
      projects: input.projects.map((item) => ({ projectKey: item.projectKey, role: item.role })).sort(compareCanonical),
      evidence: input.evidence.map((item) => ({ evidenceId: item.evidenceId, role: item.role })).sort(compareCanonical)
    }));
    const id = stableId('ctxcand', fingerprint);
    const now = new Date().toISOString();
    return this.client.transaction(() => {
      const inserted = this.client.prepare(`
        INSERT INTO context_candidates (
          id, extraction_run_id, candidate_type, scope, summary, subject_key,
          structured_payload, extraction_confidence, factual_status, review_status,
          candidate_fingerprint, external_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        ON CONFLICT(candidate_fingerprint) DO NOTHING
      `).run(id, input.extractionRunId, input.candidateType, input.scope,
        normalizeText(input.summary), input.subjectKey?.trim() || null,
        canonicalJson(input.structuredPayload), input.extractionConfidence,
        input.factualStatus, fingerprint, canonicalJson(input.externalRefs), now, now);
      const candidateId = inserted.changes === 1
        ? id
        : (this.client.prepare('SELECT id FROM context_candidates WHERE candidate_fingerprint = ?').get(fingerprint) as { id: string }).id;
      if (inserted.changes === 1) {
        const insertProject = this.client.prepare(`
          INSERT INTO context_candidate_projects (
            candidate_id, project_key, project_role, mapping_status, mapping_confidence, mapping_evidence
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        input.projects.forEach((project) => insertProject.run(candidateId, project.projectKey,
          project.role, project.mappingStatus, project.confidence, project.evidence));
        const insertEvidence = this.client.prepare(`
          INSERT INTO context_candidate_evidence (candidate_id, evidence_id, evidence_role)
          VALUES (?, ?, ?)
        `);
        input.evidence.forEach((evidence) => insertEvidence.run(candidateId, evidence.evidenceId, evidence.role));
        const insertRelation = this.client.prepare(`
          INSERT INTO context_candidate_record_relations (
            candidate_id, record_id, relation_type, status, rationale
          ) VALUES (?, ?, ?, 'suggested', ?)
        `);
        input.suggestedRelations.forEach((relation) => insertRelation.run(candidateId,
          relation.recordId, relation.relationType, relation.rationale));
      }
      const candidate = this.getCandidate(candidateId);
      if (!candidate) throw new Error('candidate insert could not be read back');
      return { created: inserted.changes === 1, candidate };
    })();
  }

  getCandidate(id: string): ContextCandidateRecord | null {
    const row = this.client.prepare('SELECT * FROM context_candidates WHERE id = ?').get(id) as CandidateRow | undefined;
    if (!row) return null;
    const projects = this.client.prepare(`
      SELECT project_key, project_role, mapping_status, mapping_confidence, mapping_evidence
      FROM context_candidate_projects WHERE candidate_id = ? ORDER BY project_role, project_key
    `).all(id) as CandidateProjectRow[];
    const evidence = this.client.prepare(`
      SELECT ce.evidence_id, ce.evidence_role, e.excerpt, e.source_id, e.source_version,
        e.evidence_level, s.occurred_at AS source_occurred_at
      FROM context_candidate_evidence ce
      INNER JOIN context_evidence e ON e.id = ce.evidence_id
      INNER JOIN context_sources s ON s.id = e.source_id
      WHERE ce.candidate_id = ? ORDER BY ce.evidence_id
    `).all(id) as CandidateEvidenceRow[];
    const relations = this.client.prepare(`
      SELECT record_id, relation_type, rationale
      FROM context_candidate_record_relations WHERE candidate_id = ? AND status = 'suggested'
      ORDER BY record_id, relation_type
    `).all(id) as CandidateRelationRow[];
    return {
      id: row.id, extractionRunId: row.extraction_run_id, candidateType: row.candidate_type,
      scope: row.scope, summary: row.summary, subjectKey: row.subject_key,
      structuredPayload: JSON.parse(row.structured_payload) as Record<string, unknown>,
      extractionConfidence: row.extraction_confidence, factualStatus: row.factual_status,
      reviewStatus: row.review_status, candidateFingerprint: row.candidate_fingerprint,
      externalRefs: JSON.parse(row.external_refs_json) as Record<string, unknown>[],
      projects: projects.map((project) => ({ projectKey: project.project_key, role: project.project_role,
        mappingStatus: project.mapping_status, confidence: project.mapping_confidence, evidence: project.mapping_evidence })),
      evidence: evidence.map((item) => ({ evidenceId: item.evidence_id, role: item.evidence_role,
        excerpt: item.excerpt, sourceId: item.source_id, sourceVersion: item.source_version,
        sourceOccurredAt: item.source_occurred_at, evidenceLevel: item.evidence_level })),
      suggestedRelations: relations.map((relation) => ({ recordId: relation.record_id,
        relationType: relation.relation_type, rationale: relation.rationale })),
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  listByRun(runId: string): ContextCandidateRecord[] {
    const ids = this.client.prepare('SELECT id FROM context_candidates WHERE extraction_run_id = ? ORDER BY created_at, id')
      .all(runId) as Array<{ id: string }>;
    return ids.map(({ id }) => this.getCandidate(id)).filter((value): value is ContextCandidateRecord => value !== null);
  }

  private assertEvidenceBelongsToRun(runId: string, evidenceIds: readonly string[]): void {
    const query = this.client.prepare(`
      SELECT 1 FROM context_evidence e
      INNER JOIN context_extraction_run_sources rs ON rs.source_id = e.source_id
      WHERE rs.extraction_run_id = ? AND e.id = ?
    `);
    for (const evidenceId of new Set(evidenceIds)) {
      if (!query.get(runId, evidenceId)) throw new Error('candidate evidence does not belong to extraction run sources');
    }
  }
}

function normalizeText(value: string): string { return value.trim().replace(/\s+/g, ' '); }
function compareCanonical(a: unknown, b: unknown): number { return canonicalJson(a).localeCompare(canonicalJson(b)); }
interface CandidateRow { id: string; extraction_run_id: string; candidate_type: ContextCandidateType; scope: ContextScope; summary: string; subject_key: string | null; structured_payload: string; extraction_confidence: number; factual_status: ContextFactualStatus; review_status: ContextReviewStatus; candidate_fingerprint: string; external_refs_json: string; created_at: string; updated_at: string }
interface CandidateProjectRow { project_key: string | null; project_role: ContextProjectRole; mapping_status: ContextProjectMappingStatus; mapping_confidence: ContextProjectConfidence; mapping_evidence: string }
interface CandidateEvidenceRow { evidence_id: string; evidence_role: ContextEvidenceRole; excerpt: string; source_id: string; source_version: number; source_occurred_at: string; evidence_level: 'derived_summary' | 'primary_statement' | 'authoritative_record' | 'direct_observation' }
interface CandidateRelationRow { record_id: string; relation_type: ContextRelationType; rationale: string }
