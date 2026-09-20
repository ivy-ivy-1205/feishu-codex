import type {
  CurrentPerspective,
  FounderRole,
  PerspectiveKind,
  PerspectiveSpeechAct,
  PerspectiveVersion
} from '../domain/alignment.js';
import type { AlignmentRepository } from '../repositories/alignment-repository.js';
import { compareEvidence, evidenceOrder, isStrictlyNewer } from './evidence-order.js';

export type PerspectiveObservationSpeechAct = PerspectiveSpeechAct | 'non_decision';

export interface PerspectiveObservation {
  topicId: string;
  evidenceId: string;
  statement: string;
  speechAct: PerspectiveObservationSpeechAct;
  decisionKey: string | null;
  confidence: number;
  observedAt: Date;
}

export interface PerspectiveReconciliationResult {
  founder: FounderRole | null;
  status: 'updated' | 'ignored';
  reason: 'unknown_identity' | 'non_decision' | 'historical_only' | 'duplicate' | null;
  versions: readonly PerspectiveVersion[];
}

export class PerspectiveReconciler {
  constructor(private readonly repository: AlignmentRepository) {}

  reconcile(input: PerspectiveObservation): PerspectiveReconciliationResult {
    return this.repository.runInTransaction(() => this.reconcileInTransaction(input));
  }

  reconcileBatch(inputs:readonly PerspectiveObservation[]):PerspectiveReconciliationResult[] {
    return this.repository.runInTransaction(()=>{
      const accepted=inputs.filter(input=>this.audit(input));
      // Evaluate each founder's effective latest view, not model array order.
      const effective=accepted.filter(input=>!accepted.some(other=>other.speechAct!=='non_decision' && other.topicId===input.topicId &&
        this.repository.resolveFounderForEvidence(other.evidenceId)===this.repository.resolveFounderForEvidence(input.evidenceId) &&
        compareEvidence(this.repository.client,other.evidenceId,input.evidenceId)===1));
      effective.sort((a,b)=>compareEvidence(this.repository.client,a.evidenceId,b.evidenceId)??0);
      return effective.map(input=>this.reconcileInTransaction(input,true));
    });
  }

  private audit(input:PerspectiveObservation):boolean {
    if(!this.repository.getAttributedFounderEvidence(input.evidenceId))return false;
    return this.repository.client.prepare(`INSERT INTO founder_perspective_observations
      (topic_id,evidence_id,statement,speech_act,decision_key) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(input.topicId,input.evidenceId,input.statement,input.speechAct,input.decisionKey).changes===1;
  }

  private ambiguousSupport(perspective:CurrentPerspective):boolean {
    const rows=this.repository.client.prepare(`SELECT evidence_id,statement,speech_act FROM founder_perspective_observations
      WHERE topic_id=?`).all(perspective.topicId) as {evidence_id:string;statement:string;speech_act:string}[];
    return rows.some(row=>!perspective.evidenceIds.includes(row.evidence_id) &&
      this.repository.resolveFounderForEvidence(row.evidence_id)===(perspective.kind==='ivy_view'?'ivy':'james') &&
      perspective.evidenceIds.some(id=>compareEvidence(this.repository.client,row.evidence_id,id)===0) &&
      (row.statement!==perspective.statement || row.speech_act!==perspective.speechAct));
  }

  private reconcileInTransaction(input: PerspectiveObservation, audited=false): PerspectiveReconciliationResult {
    const sourceEvidence = this.repository.getAttributedFounderEvidence(input.evidenceId);
    if (!sourceEvidence) {
      return { founder: null, status: 'ignored', reason: 'unknown_identity', versions: [] };
    }
    const founder = sourceEvidence.founder;
    if(!audited && !this.audit(input))return{founder,status:'ignored',reason:'duplicate',versions:[]};
    if (input.speechAct === 'non_decision') {
      return { founder, status: 'ignored', reason: 'non_decision', versions: [] };
    }

    const kind = founderViewKind(founder);
    const current = this.repository.getCurrentPerspective(input.topicId, kind);
    if(current && !isStrictlyNewer(this.repository.client,input.evidenceId,current.evidenceIds))
      return{founder,status:'ignored',reason:'historical_only',versions:[]};
    const order=evidenceOrder(this.repository.client,input.evidenceId);
    if(!order)return{founder,status:'ignored',reason:'historical_only',versions:[]};
    const version = this.repository.savePerspective({
      topicId: input.topicId,
      kind,
      expectedVersion: current?.versionNumber ?? 0,
      statement: input.statement,
      confidence: input.confidence,
      evidenceIds: [input.evidenceId],
      decisionKey: input.decisionKey,
      speechAct: input.speechAct,
      observedAt: new Date(order.occurredAt)
    });
    const versions = [version];
    const agreedDecision = input.speechAct === 'explicit_agreement' && input.decisionKey
      ? parseExplicitAgreement(sourceEvidence.sourceText)
      : null;
    if (agreedDecision && input.decisionKey) {
      const otherFounder = founder === 'ivy' ? 'james' : 'ivy';
      const other = this.repository.getCurrentPerspective(
        input.topicId,
        founderViewKind(otherFounder)
      );
      if (other && other.decisionKey === input.decisionKey &&
        other.evidenceIds.every(id=>{const order=compareEvidence(this.repository.client,input.evidenceId,id);return order!==null && order>=0;}) &&
        !this.ambiguousSupport(other) && !this.ambiguousSupport({...version,createdAt:'',updatedAt:''}) &&
        this.hasMatchingDirectSupport(other, otherFounder, agreedDecision)) {
        const shared = this.repository.getCurrentPerspective(input.topicId, 'shared_decision');
        versions.push(this.repository.savePerspective({
          topicId: input.topicId,
          kind: 'shared_decision',
          expectedVersion: shared?.versionNumber ?? 0,
          statement: other.statement,
          confidence: Math.min(other.confidence, input.confidence),
          evidenceIds: [...other.evidenceIds, input.evidenceId],
          decisionKey: input.decisionKey,
          speechAct: 'explicit_agreement',
          observedAt: input.observedAt
        }));
      }
    }
    if (input.speechAct === 'explicit_disagreement' && input.decisionKey &&
      hasExplicitDisagreementLanguage(sourceEvidence.sourceText)) {
      const otherFounder = founder === 'ivy' ? 'james' : 'ivy';
      const other = this.repository.getCurrentPerspective(
        input.topicId,
        founderViewKind(otherFounder)
      );
      const hasOtherFounderEvidence = other?.evidenceIds.some(
        (evidenceId) => this.repository.resolveFounderForEvidence(evidenceId) === otherFounder
      ) ?? false;
      if (other && other.decisionKey === input.decisionKey && hasOtherFounderEvidence) {
        const unresolved = this.repository.getCurrentPerspective(input.topicId, 'unresolved');
        versions.push(this.repository.savePerspective({
          topicId: input.topicId,
          kind: 'unresolved',
          expectedVersion: unresolved?.versionNumber ?? 0,
          statement: input.statement,
          confidence: Math.min(other.confidence, input.confidence),
          evidenceIds: [...other.evidenceIds, input.evidenceId],
          decisionKey: input.decisionKey,
          speechAct: 'explicit_disagreement',
          observedAt: input.observedAt
        }));
      }
    }
    return { founder, status: 'updated', reason: null, versions };
  }

  private hasMatchingDirectSupport(
    perspective: CurrentPerspective,
    expectedFounder: FounderRole,
    agreedDecision: string
  ): boolean {
    const parseSupport = perspective.speechAct === 'decision_proposal'
      ? parseDirectProposal
      : perspective.speechAct === 'explicit_agreement'
        ? parseExplicitAgreement
        : null;
    if (!parseSupport) return false;
    return perspective.evidenceIds.some((evidenceId) => {
      const evidence = this.repository.getAttributedFounderEvidence(evidenceId);
      if (!evidence || evidence.founder !== expectedFounder ||
        !evidence.excerpt.includes(perspective.statement)) return false;
      return parseSupport(evidence.sourceText) === agreedDecision;
    });
  }
}

function founderViewKind(founder: FounderRole): PerspectiveKind {
  return founder === 'ivy' ? 'ivy_view' : 'james_view';
}

function parseExplicitAgreement(sourceText: string): string | null {
  const text = completeDirectDecisionText(sourceText);
  if (!text) return null;
  const chinese = text.match(/^(?:我(?:们)?)?(?:明确)?(?:同意|赞成|批准|确认|没问题)[，,;；\s]*(.+)$/u);
  if (chinese) return parseDirectProposal(chinese[1]);
  const english = text.match(/^(?:i|we)?\s*(?:agree(?:d)?|approve(?:d)?)[,:;\s]+(?:to\s+)?(.+)$/iu);
  return english ? parseDirectProposal(english[1]) : null;
}

function parseDirectProposal(sourceText: string): string | null {
  const text = completeDirectDecisionText(sourceText);
  if (!text) return null;
  const trimmed = text.replace(/[。.!！]$/u, '').trim();
  const chinese = trimmed.match(/^(?:我(?:们)?[，,\s]*)?(?:决定|确认|确定)?[，,\s]*(?:就)?((?:按|采用|执行|选择).+)$/u)?.[1];
  if (chinese && (/^(?:采用|执行|选择).+/u.test(chinese) ||
    /^按.+(?:推进|执行|实施|落地|上线|启动|发布|交付|处理|做)$/u.test(chinese))) {
    return normalizeDecision(chinese);
  }
  const english = trimmed.match(/^(?:we\s+)?(?:decide(?:d)?\s+to\s+)?((?:proceed\s+with|move\s+forward\s+with|go\s+ahead\s+with|implement|ship|launch|use|adopt|choose)\s+.+)$/iu)?.[1];
  return english ? normalizeDecision(english) : null;
}

function completeDirectDecisionText(sourceText: string): string | null {
  const text = sourceText.normalize('NFKC').trim();
  if (!text || /(?:\.\.\.|\u2026|未完|省略|to be continued)/iu.test(text)) return null;
  if (/["“”‘’]/u.test(text) ||
    /(?:说|表示|提到|写道|引用|转述)[：:，,\s]*|\b(?:said|says|wrote|quoted?|according to)\b/iu.test(text)) return null;
  if (/(?:如果|假如|倘若|若|除非|前提是|只要|取决于|视.+而定|待.+(?:后|再))|\b(?:if|unless|provided|assuming|when|once|subject\s+to|depending\s+on|as\s+long\s+as)\b/iu.test(text)) return null;
  if (/(?:不同意|不赞成|不批准|反对|拒绝|不要|不能|不应|不可以|未同意|尚未同意)|\b(?:no|not|never|disagree|oppose|reject|decline|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|mustn't)\b/iu.test(text)) return null;
  return text;
}

function normalizeDecision(decision: string): string {
  return decision.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\s，,;；:：。.!！]+/gu, '');
}

function hasExplicitDisagreementLanguage(statement: string): boolean {
  return /(不同意|不赞成|反对|不要按|不能按|不应(?:该)?按|\bdisagree\b|\boppose[ds]?\b|\bdo not proceed\b)/iu
    .test(statement);
}
