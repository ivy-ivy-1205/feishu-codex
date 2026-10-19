import type Database from 'better-sqlite3';
import type { ContextFactualStatus, ContextRelationType, ContextReviewStatus } from '../domain/context.js';
import { ContextCandidateRepository } from './context-candidate-repository.js';
import { stableId } from '../services/canonical-json.js';

export interface PromoteCandidateInput {
  candidateId: string;
  expectedReviewStatus: 'pending' | 'needs_clarification' | 'conflict';
  reviewerOpenId: string;
  action: 'approve' | 'reject' | 'request_clarification' | 'mark_conflict';
  approvedSummary?: string;
  approvedPayload?: Record<string, unknown>;
  decidedFactualStatus?: ContextFactualStatus;
  targetRecordId?: string;
  relationType?: ContextRelationType;
  reason?: string;
  idempotencyKey: string;
  reviewedAt: Date;
}

export interface ContextReviewResult {
  outcome: 'applied' | 'replayed';
  reviewId: string;
  candidateId: string;
  reviewStatus: ContextReviewStatus;
  factualStatus: ContextFactualStatus;
  recordId: string | null;
  recordVersionId: string | null;
  versionNumber: number | null;
}

export class ContextReviewConflictError extends Error {
  readonly code = 'CONTEXT_REVIEW_CONFLICT';
  constructor(message: string) { super(message); this.name = 'ContextReviewConflictError'; }
}

export class ContextRecordRepository {
  constructor(readonly client: Database.Database) {}

  promoteCandidate(input: PromoteCandidateInput): ContextReviewResult {
    const promote = this.client.transaction((): ContextReviewResult => {
      const replay = this.findReviewResult(input.idempotencyKey);
      if (replay) return { ...replay, outcome: 'replayed' };

      const candidate = new ContextCandidateRepository(this.client).getCandidate(input.candidateId);
      if (!candidate) throw new ContextReviewConflictError('context candidate not found');
      if (candidate.reviewStatus !== input.expectedReviewStatus) {
        throw new ContextReviewConflictError(`candidate already handled with status ${candidate.reviewStatus}`);
      }
      const reviewerOpenId = input.reviewerOpenId.trim();
      if (!reviewerOpenId) throw new Error('reviewer identity is required');
      const idempotencyKey = input.idempotencyKey.trim();
      if (!idempotencyKey) throw new Error('review idempotency key is required');

      const reviewId = stableId('ctxreview', idempotencyKey);
      const factualStatus = decideFactualStatus(candidate, input);
      const reviewStatus = statusForAction(input.action);
      const reviewedAt = input.reviewedAt.toISOString();
      const targetRecord = input.targetRecordId
        ? this.getRecord(input.targetRecordId)
        : null;
      if (input.targetRecordId && !targetRecord) {
        throw new ContextReviewConflictError('target context record not found');
      }
      if (targetRecord?.lifecycleStatus === 'archived') {
        throw new ContextReviewConflictError('target context record is archived');
      }
      if (targetRecord && targetRecord.scope !== candidate.scope) {
        throw new ContextReviewConflictError('target context record scope mismatch');
      }
      validateRelationIntent(input, Boolean(targetRecord));
      if (input.action === 'approve') this.assertCandidateCanBeApproved(candidate);

      this.client.prepare(`
        INSERT INTO context_reviews (
          id, candidate_id, action, reviewer_open_id, approved_summary,
          approved_payload, decided_factual_status, target_record_id, relation_type,
          reason, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reviewId, candidate.id, input.action, reviewerOpenId,
        input.approvedSummary?.trim() || null,
        input.approvedPayload ? JSON.stringify(input.approvedPayload) : null,
        factualStatus, input.targetRecordId ?? null, input.relationType ?? null,
        input.reason?.trim() || null, idempotencyKey, reviewedAt);

      const candidateUpdate = this.client.prepare(`
        UPDATE context_candidates
        SET review_status = ?, factual_status = ?, updated_at = ?
        WHERE id = ? AND review_status = ?
      `).run(reviewStatus, factualStatus, reviewedAt, candidate.id, input.expectedReviewStatus);
      if (candidateUpdate.changes !== 1) throw new ContextReviewConflictError('candidate review race lost');

      if (input.action === 'mark_conflict' && targetRecord) {
        this.client.prepare(`UPDATE context_records SET lifecycle_status = 'disputed', updated_at = ? WHERE id = ?`)
          .run(reviewedAt, targetRecord.id);
        this.confirmCandidateRelation(candidate.id, targetRecord.id, 'conflicts_with', input.reason ?? 'Ivy marked conflict');
        return { outcome: 'applied', reviewId, candidateId: candidate.id, reviewStatus,
          factualStatus, recordId: targetRecord.id, recordVersionId: null, versionNumber: null };
      }
      if (input.action !== 'approve') {
        return { outcome: 'applied', reviewId, candidateId: candidate.id, reviewStatus,
          factualStatus, recordId: null, recordVersionId: null, versionNumber: null };
      }
      if (targetRecord && input.relationType === 'duplicates') {
        this.confirmCandidateRelation(candidate.id, targetRecord.id, 'duplicates', input.reason ?? 'Ivy marked duplicate');
        return { outcome: 'applied', reviewId, candidateId: candidate.id, reviewStatus,
          factualStatus, recordId: targetRecord.id, recordVersionId: null, versionNumber: null };
      }

      const recordId = targetRecord?.id ?? stableId('ctxrec', candidate.id);
      if (!targetRecord) {
        this.client.prepare(`
          INSERT INTO context_records (
            id, record_type, scope, subject_key, lifecycle_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?)
        `).run(recordId, candidate.candidateType, candidate.scope, candidate.subjectKey, reviewedAt, reviewedAt);
      }
      const previous = targetRecord ? this.getLatestVersion(targetRecord.id) : null;
      if (targetRecord && !previous) throw new Error('target context record has no version');
      const versionNumber = (previous?.versionNumber ?? 0) + 1;
      const recordVersionId = stableId('ctxver', `${recordId}:${versionNumber}:${candidate.id}:${reviewId}`);
      const candidateSummary = input.approvedSummary?.trim() || candidate.summary;
      const candidatePayload = input.approvedPayload ?? candidate.structuredPayload;
      const versionSummary = previous && input.relationType === 'supplements'
        ? composeSupplementSummary(previous.summary, candidateSummary)
        : previous && input.relationType === 'confirms' ? previous.summary : candidateSummary;
      const versionPayload = previous && input.relationType === 'supplements'
        ? { previous: previous.structuredPayload, supplement: candidatePayload }
        : previous && input.relationType === 'confirms' ? previous.structuredPayload : candidatePayload;
      this.client.prepare(`
        INSERT INTO context_record_versions (
          id, record_id, version_number, summary, structured_payload, factual_status,
          source_candidate_id, reviewer_open_id, reviewed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(recordVersionId, recordId, versionNumber, versionSummary,
        JSON.stringify(versionPayload), factualStatus,
        candidate.id, reviewerOpenId, reviewedAt, reviewedAt);
      if (previous && (input.relationType === 'supplements' || input.relationType === 'confirms')) {
        this.copyPreviousVersionLinks(previous.id, recordVersionId);
      }
      this.copyProjects(candidate.id, recordVersionId);
      this.copyEvidence(candidate.id, recordVersionId);

      if (previous && input.relationType) {
        const relationId = stableId('ctxrel', `${recordVersionId}:${previous.id}:${input.relationType}`);
        this.client.prepare(`
          INSERT INTO context_record_relations (
            id, from_record_version_id, to_record_version_id, relation_type, review_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(relationId, recordVersionId, previous.id, input.relationType, reviewId, reviewedAt);
        this.confirmCandidateRelation(candidate.id, recordId, input.relationType,
          input.reason ?? `Ivy confirmed ${input.relationType}`);
      }
      this.client.prepare(`UPDATE context_records SET updated_at = ? WHERE id = ?`).run(reviewedAt, recordId);
      return { outcome: 'applied', reviewId, candidateId: candidate.id, reviewStatus,
        factualStatus, recordId, recordVersionId, versionNumber };
    });
    return promote();
  }

  listCurrentSummaries(limit = 100): Array<{ id: string; type: string; scope: string; summary: string; factualStatus: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid Context summary limit');
    return this.client.prepare(`
      SELECT r.id, r.record_type AS type, r.scope, v.summary, v.factual_status AS factualStatus
      FROM context_records r
      INNER JOIN context_record_versions v ON v.record_id = r.id
      INNER JOIN (
        SELECT record_id, MAX(version_number) AS version_number
        FROM context_record_versions GROUP BY record_id
      ) latest ON latest.record_id = v.record_id AND latest.version_number = v.version_number
      WHERE r.lifecycle_status IN ('active', 'disputed')
      ORDER BY r.updated_at DESC LIMIT ?
    `).all(limit) as Array<{ id: string; type: string; scope: string; summary: string; factualStatus: string }>;
  }

  getVersionProvenance(versionId: string): {
    recordId: string;
    versionNumber: number;
    candidateId: string;
    evidence: Array<{ evidenceId: string; evidenceRole: string; sourceId: string;
      sourceVersion: number; contentHash: string }>;
  } | null {
    const version = this.client.prepare(`
      SELECT record_id, version_number, source_candidate_id
      FROM context_record_versions WHERE id = ?
    `).get(versionId) as { record_id: string; version_number: number; source_candidate_id: string } | undefined;
    if (!version) return null;
    const evidence = this.client.prepare(`
      SELECT re.evidence_id, re.evidence_role, e.source_id, e.source_version, s.content_hash
      FROM context_record_evidence re
      INNER JOIN context_evidence e ON e.id = re.evidence_id
      INNER JOIN context_sources s ON s.id = e.source_id
      WHERE re.record_version_id = ? ORDER BY re.evidence_id
    `).all(versionId) as Array<{ evidence_id: string; evidence_role: string; source_id: string;
      source_version: number; content_hash: string }>;
    return {
      recordId: version.record_id, versionNumber: version.version_number,
      candidateId: version.source_candidate_id,
      evidence: evidence.map((item) => ({ evidenceId: item.evidence_id,
        evidenceRole: item.evidence_role, sourceId: item.source_id,
        sourceVersion: item.source_version, contentHash: item.content_hash }))
    };
  }

  private assertCandidateCanBeApproved(candidate: NonNullable<ReturnType<ContextCandidateRepository['getCandidate']>>): void {
    if (!candidate.evidence.some((item) => item.role === 'supporting')) {
      throw new ContextReviewConflictError('candidate has no supporting evidence');
    }
    if (candidate.scope === 'project') {
      const primary = candidate.projects.filter((project) =>
        project.role === 'primary' && project.mappingStatus === 'mapped' && project.projectKey);
      if (primary.length !== 1) throw new ContextReviewConflictError('project candidate requires exactly one mapped primary project');
    }
  }

  private copyProjects(candidateId: string, versionId: string): void {
    this.client.prepare(`
      INSERT OR IGNORE INTO context_record_projects (record_version_id, project_key, project_role)
      SELECT ?, project_key, project_role FROM context_candidate_projects
      WHERE candidate_id = ? AND project_key IS NOT NULL AND mapping_status = 'mapped'
    `).run(versionId, candidateId);
  }

  private copyEvidence(candidateId: string, versionId: string): void {
    this.client.prepare(`
      INSERT OR IGNORE INTO context_record_evidence (record_version_id, evidence_id, evidence_role)
      SELECT ?, evidence_id, evidence_role FROM context_candidate_evidence WHERE candidate_id = ?
    `).run(versionId, candidateId);
  }

  private copyPreviousVersionLinks(previousVersionId: string, newVersionId: string): void {
    this.client.prepare(`
      INSERT OR IGNORE INTO context_record_projects (record_version_id, project_key, project_role)
      SELECT ?, project_key, project_role FROM context_record_projects WHERE record_version_id = ?
    `).run(newVersionId, previousVersionId);
    this.client.prepare(`
      INSERT OR IGNORE INTO context_record_evidence (record_version_id, evidence_id, evidence_role)
      SELECT ?, evidence_id, evidence_role FROM context_record_evidence WHERE record_version_id = ?
    `).run(newVersionId, previousVersionId);
  }

  private confirmCandidateRelation(candidateId: string, recordId: string, relationType: ContextRelationType, rationale: string): void {
    this.client.prepare(`
      INSERT INTO context_candidate_record_relations (
        candidate_id, record_id, relation_type, status, rationale
      ) VALUES (?, ?, ?, 'confirmed', ?)
      ON CONFLICT(candidate_id, record_id, relation_type)
      DO UPDATE SET status = 'confirmed', rationale = excluded.rationale
    `).run(candidateId, recordId, relationType, rationale);
  }

  private getRecord(id: string): { id: string; scope: string; lifecycleStatus: string } | null {
    const row = this.client.prepare(`SELECT id, scope, lifecycle_status FROM context_records WHERE id = ?`).get(id) as
      { id: string; scope: string; lifecycle_status: string } | undefined;
    return row ? { id: row.id, scope: row.scope, lifecycleStatus: row.lifecycle_status } : null;
  }

  private getLatestVersion(recordId: string): { id: string; versionNumber: number; summary: string;
    structuredPayload: Record<string, unknown> } | null {
    const row = this.client.prepare(`
      SELECT id, version_number, summary, structured_payload FROM context_record_versions
      WHERE record_id = ? ORDER BY version_number DESC LIMIT 1
    `).get(recordId) as { id: string; version_number: number; summary: string; structured_payload: string } | undefined;
    return row ? { id: row.id, versionNumber: row.version_number, summary: row.summary,
      structuredPayload: JSON.parse(row.structured_payload) as Record<string, unknown> } : null;
  }

  private findReviewResult(idempotencyKey: string): Omit<ContextReviewResult, 'outcome'> | null {
    const row = this.client.prepare(`
      SELECT r.id, r.candidate_id, c.review_status, c.factual_status,
        v.record_id, v.id AS version_id, v.version_number, r.target_record_id
      FROM context_reviews r
      INNER JOIN context_candidates c ON c.id = r.candidate_id
      LEFT JOIN context_record_versions v ON v.source_candidate_id = r.candidate_id
        AND v.reviewed_at = r.created_at
      WHERE r.idempotency_key = ?
      ORDER BY v.version_number DESC LIMIT 1
    `).get(idempotencyKey) as ReviewResultRow | undefined;
    return row ? { reviewId: row.id, candidateId: row.candidate_id,
      reviewStatus: row.review_status, factualStatus: row.factual_status,
      recordId: row.record_id ?? row.target_record_id,
      recordVersionId: row.version_id, versionNumber: row.version_number } : null;
  }
}

function statusForAction(action: PromoteCandidateInput['action']): ContextReviewStatus {
  if (action === 'approve') return 'approved';
  if (action === 'reject') return 'rejected';
  if (action === 'request_clarification') return 'needs_clarification';
  return 'conflict';
}

function decideFactualStatus(
  candidate: NonNullable<ReturnType<ContextCandidateRepository['getCandidate']>>,
  input: PromoteCandidateInput
): ContextFactualStatus {
  if (input.action === 'mark_conflict') return 'disputed';
  if (!input.decidedFactualStatus || input.decidedFactualStatus === candidate.factualStatus) {
    return candidate.factualStatus;
  }
  if (input.action === 'approve' && input.decidedFactualStatus === 'evidence_verified') {
    if (!candidate.evidence.some((item) =>
      item.evidenceLevel === 'direct_observation' || item.evidenceLevel === 'authoritative_record')) {
      throw new Error('evidence_verified requires direct or authoritative evidence');
    }
    return 'evidence_verified';
  }
  if (input.decidedFactualStatus !== candidate.factualStatus) {
    throw new Error('review approval must preserve factual status; verification requires a separate evidence decision');
  }
  return candidate.factualStatus;
}

function validateRelationIntent(input: PromoteCandidateInput, hasTarget: boolean): void {
  if (hasTarget !== Boolean(input.relationType)) throw new Error('target record and relation type must be provided together');
  if (input.action === 'mark_conflict' && hasTarget && input.relationType !== 'conflicts_with') {
    throw new Error('mark_conflict requires conflicts_with relation');
  }
  if (input.action === 'approve' && input.relationType === 'conflicts_with') {
    throw new Error('conflict cannot be approved as an overwrite');
  }
  if (input.action !== 'approve' && input.action !== 'mark_conflict' && hasTarget) {
    throw new Error('target relation is not valid for this review action');
  }
}

interface ReviewResultRow { id: string; candidate_id: string; review_status: ContextReviewStatus; factual_status: ContextFactualStatus; record_id: string | null; version_id: string | null; version_number: number | null; target_record_id: string | null }

function composeSupplementSummary(previous: string, addition: string): string {
  if (previous.includes(addition)) return previous;
  if (addition.includes(previous)) return addition;
  return `${previous}\n\n补充：${addition}`;
}
