import {
  validateFounderStreamAnalysis,
  validateFounderStreamInput,
  type FounderEvidenceExcerpt,
  type FounderStreamAnalysis,
  type FounderStreamInput,
  type TopicProposal
} from '../ports/founder-stream-analyzer.js';

export interface TopicConfirmationSuggestion {
  type: 'possible_continuation' | 'split_from';
  topicId: string;
  status: 'needs_confirmation';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

export interface ReconciledTopic {
  proposalIndex: number;
  proposal: TopicProposal;
  action: 'create' | 'join';
  topicId: string | null;
  expectedVersion: number | null;
  sourceIds: string[];
  evidenceExcerpts: FounderEvidenceExcerpt[];
  relations: TopicConfirmationSuggestion[];
}

export interface TopicReconciliation {
  topics: ReconciledTopic[];
}

/** Pure policy: creates no topic IDs, database rows, tasks, messages or authority. */
export function reconcileTopics(
  input: FounderStreamInput,
  analysis: FounderStreamAnalysis
): TopicReconciliation {
  const supplied = validateFounderStreamInput(input);
  const validated = validateFounderStreamAnalysis(analysis, supplied);
  const currentTopics = new Map(supplied.currentTopics.map((topic) => [topic.id, topic]));
  const targetCounts = new Map<string, number>();
  for (const proposal of validated.topics) {
    const id = proposal.joinDecision.topicId;
    if (id !== null) targetCounts.set(id, (targetCounts.get(id) ?? 0) + 1);
  }

  return { topics: validated.topics.map((proposal, proposalIndex): ReconciledTopic => {
    const join = proposal.joinDecision;
    const target = join.topicId === null ? undefined : currentTopics.get(join.topicId);
    const autoJoin = target !== undefined && target.stage !== 'closed' &&
      join.kind === 'exact_continuation' && proposal.confidence === 'high' &&
      join.confidence === 'high' && proposal.displayName === target.displayName &&
      join.sharedTerms.some((term) => term === target.displayName) &&
      targetCounts.get(target.id) === 1 && proposal.splitSuggestions.length === 0;
    const relations: TopicConfirmationSuggestion[] = [];
    if (target && !autoJoin) {
      relations.push({ type: 'possible_continuation', topicId: target.id,
        status: 'needs_confirmation', confidence: join.confidence,
        rationale: 'Continuation did not satisfy all automatic-join evidence and confidence gates.' });
    }
    for (const split of proposal.splitSuggestions) {
      relations.push({ type: 'split_from', topicId: split.topicId,
        status: 'needs_confirmation', confidence: split.confidence, rationale: split.rationale });
    }
    const evidenceExcerpts = deduplicateExcerpts([
      ...(autoJoin ? target.evidenceExcerpts : []), ...proposal.evidenceExcerpts
    ]);
    return {
      proposalIndex, proposal,
      action: autoJoin ? 'join' : 'create',
      topicId: autoJoin ? target.id : null,
      expectedVersion: autoJoin ? target.currentVersion : null,
      sourceIds: [...new Set(evidenceExcerpts.map((evidence) => evidence.sourceId))].sort(),
      evidenceExcerpts,
      relations
    };
  }) };
}

function deduplicateExcerpts(excerpts: readonly FounderEvidenceExcerpt[]): FounderEvidenceExcerpt[] {
  const unique = new Map<string, FounderEvidenceExcerpt>();
  for (const evidence of excerpts) unique.set(JSON.stringify([evidence.sourceId, evidence.excerpt]), evidence);
  return [...unique.values()];
}
