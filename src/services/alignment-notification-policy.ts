import type { AlignmentCandidate } from '../domain/alignment.js';
import type { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import type { AlignmentRepository } from '../repositories/alignment-repository.js';
import type { OutboxRepository } from '../repositories/outbox-repository.js';
import { AlignmentDetector } from './alignment-detector.js';
import { canonicalJson } from './canonical-json.js';
import { compareEvidence, evidenceOrder } from './evidence-order.js';

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

  recordShadowCandidate(candidate: AlignmentCandidate, now: Date): { recorded: boolean; reason: AlignmentNotificationDecision['reason'] } {
    return this.issues.client.transaction(() => {
      this.reconcilePending(now);
      const decision = this.evaluate(candidate, now);
      if (!decision.send) return { recorded: false, reason: decision.reason };
      const existed = this.issues.get(candidate.id) !== null;
      this.issues.saveCandidate(candidate, now);
      return { recorded: !existed, reason: decision.reason };
    }).immediate();
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

    if(candidate.evidenceIds.some(id=>!evidenceOrder(this.issues.client,id)))return reject('ungrounded_divergence');
    if(candidate.evidenceIds.some(id=>evidenceOrder(this.issues.client,id)!.latestAt>now.getTime()))return reject('outside_action_horizon');
    const matchingDecisions = this.perspectives.listPerspectiveVersions(candidate.topicId, 'shared_decision')
      .filter((shared) => shared.decisionKey === candidate.decisionKey && this.perspectives.isSharedDecisionEffective(shared));
    if (matchingDecisions.some((shared) => {
      const times = shared.evidenceIds.map((id) => evidenceOrder(this.issues.client,id)?.latestAt ?? NaN);
      return times.length > 0 && times.every(Number.isFinite) &&
        shared.evidenceIds.some(id=>candidate.evidenceIds.every(previous=>compareEvidence(this.issues.client,id,previous)===1)) &&
        Math.max(...times) <= now.getTime() &&
        !(['ivy_view','james_view'] as const).some(kind=>{
          const current=this.perspectives.getCurrentPerspective(candidate.topicId,kind);
          return current?.decisionKey===candidate.decisionKey && current.speechAct==='explicit_disagreement' &&
            current.evidenceIds.some(id=>shared.evidenceIds.every(previous=>compareEvidence(this.issues.client,id,previous)===1));
        }) &&
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
    if (previous.some((issue) => ['ready', 'asked'].includes(issue.status))) return reject('open_issue_exists');
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
      // The IMMEDIATE outer transaction serializes slot retirement, occupancy checks and enqueue.
      // Distinct decision keys on a topic share one outstanding question slot.
      this.reconcilePending(now);
      const decision = this.evaluate(candidate, now);
      if (!decision.send) {
        // Occupancy is checked only after evidence/action validation. Preserve valid deferred
        // work in this transaction; other rejection reasons must not create candidate audit rows.
        if (decision.reason === 'open_issue_exists') this.issues.saveCandidate(candidate, now);
        return decision;
      }
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
