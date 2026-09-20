import { alignmentProposalSchema, type AlignmentCandidate } from '../domain/alignment.js';
import { canonicalJson, sha256, stableId } from './canonical-json.js';

/** Proposal-only boundary. Neither model labels nor candidate creation authorize delivery. */
export class AlignmentDetector {
  propose(input: unknown): AlignmentCandidate {
    const proposal = alignmentProposalSchema.parse(input);
    const evidenceIds = [...new Set([proposal.ivy.evidenceId, proposal.james.evidenceId,
      ...(proposal.actionConsequence ? [proposal.actionConsequence.evidenceId] : []),
      ...(proposal.actionHorizon ? [proposal.actionHorizon.evidenceId] : [])])].sort();
    const evidenceSetHash = sha256(canonicalJson(evidenceIds));
    return { ...proposal, id: stableId('alignment', canonicalJson([
      proposal.topicId, proposal.decisionKey, proposal.dimension, evidenceSetHash
    ])), status: 'candidate', evidenceIds, evidenceSetHash };
  }
}
