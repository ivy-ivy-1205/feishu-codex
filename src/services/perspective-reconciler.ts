import type {
  FounderRole,
  PerspectiveKind,
  PerspectiveSpeechAct,
  PerspectiveVersion
} from '../domain/alignment.js';
import type { AlignmentRepository } from '../repositories/alignment-repository.js';

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
  reason: 'unknown_identity' | 'non_decision' | null;
  versions: readonly PerspectiveVersion[];
}

export class PerspectiveReconciler {
  constructor(private readonly repository: AlignmentRepository) {}

  reconcile(input: PerspectiveObservation): PerspectiveReconciliationResult {
    return this.repository.runInTransaction(() => this.reconcileInTransaction(input));
  }

  private reconcileInTransaction(input: PerspectiveObservation): PerspectiveReconciliationResult {
    const founder = this.repository.resolveFounderForEvidence(input.evidenceId);
    if (!founder) {
      return { founder: null, status: 'ignored', reason: 'unknown_identity', versions: [] };
    }
    if (input.speechAct === 'non_decision') {
      return { founder, status: 'ignored', reason: 'non_decision', versions: [] };
    }

    const kind = founderViewKind(founder);
    const current = this.repository.getCurrentPerspective(input.topicId, kind);
    const version = this.repository.savePerspective({
      topicId: input.topicId,
      kind,
      expectedVersion: current?.versionNumber ?? 0,
      statement: input.statement,
      confidence: input.confidence,
      evidenceIds: [input.evidenceId],
      decisionKey: input.decisionKey,
      speechAct: input.speechAct,
      observedAt: input.observedAt
    });
    const versions = [version];
    if (input.speechAct === 'explicit_agreement' && input.decisionKey &&
      hasExplicitAgreementLanguage(input.statement)) {
      const otherFounder = founder === 'ivy' ? 'james' : 'ivy';
      const other = this.repository.getCurrentPerspective(
        input.topicId,
        founderViewKind(otherFounder)
      );
      const hasOtherFounderEvidence = other?.evidenceIds.some(
        (evidenceId) => this.repository.resolveFounderForEvidence(evidenceId) === otherFounder
      ) ?? false;
      const otherExplicitlySupports = other?.speechAct === 'decision_proposal' ||
        (other?.speechAct === 'explicit_agreement' &&
          hasExplicitAgreementLanguage(other.statement));
      if (other && other.decisionKey === input.decisionKey && otherExplicitlySupports &&
        hasOtherFounderEvidence) {
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
      hasExplicitDisagreementLanguage(input.statement)) {
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
}

function founderViewKind(founder: FounderRole): PerspectiveKind {
  return founder === 'ivy' ? 'ivy_view' : 'james_view';
}

function hasExplicitAgreementLanguage(statement: string): boolean {
  return /(同意|赞成|就按|确认(?:按|采用|执行)|可以(?:按|采用|执行)|没问题[，,\s]*(?:按|采用|执行)|\bagree(?:d)?\b|\bapproved\b|\bgo ahead\b)/iu
    .test(statement);
}

function hasExplicitDisagreementLanguage(statement: string): boolean {
  return /(不同意|不赞成|反对|不要按|不能按|不应(?:该)?按|\bdisagree\b|\boppose[ds]?\b|\bdo not proceed\b)/iu
    .test(statement);
}
