import type { AlignmentCandidate } from '../domain/alignment.js';
import type { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import type { AlignmentRepository } from '../repositories/alignment-repository.js';
import type { OutboxRepository } from '../repositories/outbox-repository.js';
import { AlignmentDetector } from './alignment-detector.js';
import { canonicalJson } from './canonical-json.js';

export type AlignmentNotificationDecision = { send: boolean; reason:
  'action_divergence' | 'missing_dual_evidence' | 'ungrounded_divergence' |
  'no_action_consequence' | 'outside_action_horizon' | 'naturally_resolved' |
  'unchanged_evidence' | 'open_issue_exists' };

export class AlignmentNotificationPolicy {
  constructor(private readonly issues: AlignmentIssueRepository,
    private readonly perspectives: AlignmentRepository, private readonly outbox: OutboxRepository) {
    if (issues.client !== perspectives.client || issues.client !== outbox.client) {
      throw new Error('alignment policy repositories must share one database');
    }
  }

  evaluate(candidate: AlignmentCandidate, now: Date): AlignmentNotificationDecision {
    const reject = (reason: AlignmentNotificationDecision['reason']): AlignmentNotificationDecision => ({ send: false, reason });
    try {
      const { id, status, evidenceIds, evidenceSetHash, ...proposal } = candidate;
      if (canonicalJson(new AlignmentDetector().propose(proposal)) !== canonicalJson(candidate)) return reject('ungrounded_divergence');
    } catch { return reject('ungrounded_divergence'); }
    const ivy = this.perspectives.getAttributedFounderEvidence(candidate.ivy.evidenceId);
    const james = this.perspectives.getAttributedFounderEvidence(candidate.james.evidenceId);
    if (ivy?.founder !== 'ivy' || james?.founder !== 'james') return reject('missing_dual_evidence');
    if (!ivy.excerpt.includes(candidate.ivy.statement) || !james.excerpt.includes(candidate.james.statement) ||
      !directStatement(ivy.sourceText, candidate.ivy.statement) ||
      !directStatement(james.sourceText, candidate.james.statement) ||
      normalizeStatement(candidate.ivy.statement) === normalizeStatement(candidate.james.statement)) return reject('ungrounded_divergence');
    const founderEvidenceIds = [candidate.ivy.evidenceId, candidate.james.evidenceId];
    const consequence = candidate.actionConsequence;
    if (!consequence || !founderEvidenceIds.includes(consequence.evidenceId) ||
      !this.grounded(consequence) || !affirmativeAction(
        this.perspectives.getAttributedFounderEvidence(consequence.evidenceId)!.sourceText,
        consequence.excerpt
      )) return reject('no_action_consequence');
    const horizon = candidate.actionHorizon;
    if (!horizon || !founderEvidenceIds.includes(horizon.evidenceId) || !this.grounded(horizon) || !Number.isFinite(now.getTime()) ||
      Date.parse(horizon.startsAt) > now.getTime() || Date.parse(horizon.endsAt) <= now.getTime() ||
      Date.parse(horizon.startsAt) >= Date.parse(horizon.endsAt)) return reject('outside_action_horizon');

    const latestEvidenceAt = Math.max(...candidate.evidenceIds.map((id) => this.evidenceAt(id)));
    const matchingDecisions = this.perspectives.listPerspectiveVersions(candidate.topicId, 'shared_decision')
      .filter((shared) => shared.decisionKey === candidate.decisionKey);
    if (matchingDecisions.some((shared) => {
      const times = shared.evidenceIds.map((id) => this.evidenceAt(id));
      return times.length > 0 && times.every(Number.isFinite) &&
        Math.max(...times) > latestEvidenceAt && Math.max(...times) <= now.getTime() &&
        shared.evidenceIds.some((id) => this.perspectives.resolveFounderForEvidence(id) === 'ivy') &&
        shared.evidenceIds.some((id) => this.perspectives.resolveFounderForEvidence(id) === 'james');
    })) {
      return reject('naturally_resolved');
    }
    const previous = this.issues.listForTopic(candidate.topicId);
    if (previous.some((issue) => issue.status !== 'candidate' &&
      (issue.evidenceSetHash === candidate.evidenceSetHash ||
        (issue.dimension === candidate.dimension &&
          normalizeStatement(issue.ivy.statement) === normalizeStatement(candidate.ivy.statement) &&
          normalizeStatement(issue.james.statement) === normalizeStatement(candidate.james.statement) &&
          issue.actionConsequence?.excerpt === candidate.actionConsequence?.excerpt &&
          issue.actionHorizon?.startsAt === candidate.actionHorizon?.startsAt &&
          issue.actionHorizon?.endsAt === candidate.actionHorizon?.endsAt)))) {
      return reject('unchanged_evidence');
    }
    if (previous.some((issue) => issue.decisionKey === candidate.decisionKey && ['ready', 'asked'].includes(issue.status))) return reject('open_issue_exists');
    return { send: true, reason: 'action_divergence' };
  }

  /** Call after new evidence reconciliation and before each delivery tick. */
  reconcilePending(now: Date): void {
    this.issues.client.transaction(() => {
      for (const issue of this.issues.listOpen()) {
        const { createdAt, updatedAt, deliveredMessageId, status, ...rest } = issue;
        const decision = this.evaluate({ ...rest, status: 'candidate' }, now);
        if (decision.reason === 'naturally_resolved' || decision.reason === 'outside_action_horizon') {
          this.issues.close({ issueId: issue.id, expectedStatus: status,
            status: decision.reason === 'naturally_resolved' ? 'resolved' : 'stale', changedAt: now });
        }
      }
    }).immediate();
  }

  prepare(candidate: AlignmentCandidate, message: { targetChatId: string; card: Record<string, unknown> }, now: Date): AlignmentNotificationDecision {
    return this.issues.client.transaction(() => {
      const decision = this.evaluate(candidate, now);
      if (!decision.send) return decision;
      this.issues.saveCandidate(candidate, now);
      const update = this.issues.client.prepare("UPDATE alignment_issues SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'candidate'")
        .run(now.toISOString(), candidate.id);
      if (update.changes !== 1) throw new Error('ALIGNMENT_ISSUE_CONFLICT');
      this.outbox.enqueueAlignmentQuestion({ kind: 'alignment_question', issueId: candidate.id,
        evidenceSetHash: candidate.evidenceSetHash, ...message }, now);
      return decision;
    }).immediate();
  }

  private grounded(reference: { evidenceId: string; excerpt: string }): boolean {
    return this.perspectives.getAttributedFounderEvidence(reference.evidenceId)?.excerpt.includes(reference.excerpt) ?? false;
  }

  private evidenceAt(id: string): number {
    const row = this.issues.client.prepare(`SELECT s.occurred_at FROM context_evidence e
      JOIN context_sources s ON s.id = e.source_id WHERE e.id = ?`).get(id) as { occurred_at: string } | undefined;
    return row ? Date.parse(row.occurred_at) : Infinity;
  }
}

function hasAction(text: string): boolean {
  return /推进|实施|交付|发布|上线|完成|负责|截止|验收|开始|先做|implement|deliver|release|deadline|owner|complete|start/i.test(text) &&
    !/如果|假如|也许|可能|脑暴|设想|if\b|maybe|brainstorm/i.test(text);
}

/** A selected positive substring cannot override negation, withdrawal or attribution in its source. */
function affirmativeAction(source: string, excerpt: string): boolean {
  if (!source.includes(excerpt) || !hasAction(excerpt)) return false;
  return !/不|没|未|撤回|取消|暂停|停止|搁置|放弃|拒绝|说|表示|据称|提到|转述|[“”"「」『』]|如果|假如|也许|可能|\.\.\.|……|\b(?:not|never|no|cancel\w*|withdraw\w*|withdrawn|retract\w*|abandon\w*|pause\w*|stop\w*|postpone\w*|said|says?|quote\w*|reported|according|if|maybe)\b|n['’]t\b/i.test(source);
}

function directStatement(source: string, statement: string): boolean {
  const text = source.trim();
  if (/如果|假如|也许|可能|脑暴|设想|[“”"「」]|\.\.\.|……|\bif\b|\bmaybe\b|\bsubject to\b/i.test(text)) return false;
  if (!text.startsWith(statement)) return false;
  const after = text.slice(statement.length);
  return !after || /^[，。！？；,.;!?\s]/.test(after);
}

function normalizeStatement(text: string): string {
  return text.toLowerCase().replace(/^(我)?(同意|赞成)|^i agree to\s*/i, '').replace(/[\s，。,.!！]/g, '');
}
