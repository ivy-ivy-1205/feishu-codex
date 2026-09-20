import type Database from 'better-sqlite3';
import { alignmentIssueStatusSchema, type AlignmentCandidate, type AlignmentIssue, type AlignmentIssueStatus } from '../domain/alignment.js';
import { AlignmentDetector } from '../services/alignment-detector.js';
import { canonicalJson } from '../services/canonical-json.js';

export class AlignmentIssueRepository {
  constructor(readonly client: Database.Database) {}

  saveCandidate(candidate: AlignmentCandidate, at: Date): AlignmentIssue {
    const { id, status, evidenceIds, evidenceSetHash, ...proposal } = candidate;
    const validated = new AlignmentDetector().propose(proposal);
    if (canonicalJson(validated) !== canonicalJson(candidate)) throw new Error('invalid alignment candidate');
    this.client.prepare(`INSERT INTO alignment_issues
      (id, topic_id, decision_key, dimension, evidence_set_hash, candidate_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(id, candidate.topicId, candidate.decisionKey, candidate.dimension, evidenceSetHash,
        JSON.stringify(candidate), at.toISOString(), at.toISOString());
    return this.get(id)!;
  }

  get(id: string): AlignmentIssue | null {
    const row = this.client.prepare('SELECT * FROM alignment_issues WHERE id = ?').get(id) as IssueRow | undefined;
    return row ? toIssue(row) : null;
  }

  listForTopic(topicId: string): AlignmentIssue[] {
    return (this.client.prepare('SELECT * FROM alignment_issues WHERE topic_id = ? ORDER BY created_at, id')
      .all(topicId) as IssueRow[]).map(toIssue);
  }

  listOpen(): AlignmentIssue[] {
    return (this.client.prepare("SELECT * FROM alignment_issues WHERE status IN ('ready', 'asked') ORDER BY created_at, id")
      .all() as IssueRow[]).map(toIssue);
  }

  close(input: { issueId: string; expectedStatus: AlignmentIssueStatus;
    status: 'resolved' | 'dismissed' | 'stale'; changedAt: Date }): void {
    if (!['candidate', 'ready', 'asked'].includes(input.expectedStatus) ||
      !['resolved', 'dismissed', 'stale'].includes(input.status)) throw new Error('invalid alignment transition');
    const result = this.client.prepare('UPDATE alignment_issues SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(input.status, input.changedAt.toISOString(), input.issueId, input.expectedStatus);
    if (result.changes !== 1) throw new Error('ALIGNMENT_ISSUE_CONFLICT');
  }
}

interface IssueRow { id: string; candidate_json: string; status: string; delivered_message_id: string | null; created_at: string; updated_at: string }
function toIssue(row: IssueRow): AlignmentIssue {
  return { ...JSON.parse(row.candidate_json) as AlignmentCandidate, id: row.id,
    status: alignmentIssueStatusSchema.parse(row.status), deliveredMessageId: row.delivered_message_id,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
