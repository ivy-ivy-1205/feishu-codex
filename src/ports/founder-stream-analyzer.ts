import { z } from 'zod';
import { topicStageSchema } from '../domain/topic.js';
import type { ContextSourceRecord } from '../repositories/context-source-repository.js';
import { sha256 } from '../services/canonical-json.js';

const text = (max: number) => z.string().min(1).max(max).regex(/\S/);
const confidenceSchema = z.enum(['high', 'medium', 'low']);
export const founderEvidenceExcerptSchema = z.object({
  sourceId: text(256), excerpt: text(4000)
}).strict();

export const topicProposalSchema = z.object({
  displayName: text(200),
  stage: topicStageSchema,
  outcome: text(2000).nullable(),
  currentAction: text(2000).nullable(),
  confidence: confidenceSchema,
  sourceIds: z.array(text(256)).min(1).max(20),
  evidenceExcerpts: z.array(founderEvidenceExcerptSchema).min(1).max(20),
  joinDecision: z.object({
    kind: z.enum(['new', 'exact_continuation', 'possible_continuation']),
    topicId: text(256).nullable(),
    confidence: confidenceSchema,
    sharedTerms: z.array(text(200)).max(10)
  }).strict(),
  splitSuggestions: z.array(z.object({
    topicId: text(256), confidence: confidenceSchema, rationale: text(1000)
  }).strict()).max(10)
}).strict();

export const founderStreamAnalysisSchema = z.object({
  topics: z.array(topicProposalSchema).max(40)
}).strict();

const currentTopicSchema = z.object({
  id: text(256),
  currentVersion: z.number().int().positive(),
  displayName: text(200),
  stage: topicStageSchema,
  outcome: text(2000).nullable(),
  evidenceExcerpts: z.array(founderEvidenceExcerptSchema).min(1).max(20)
}).strict();

// Project registry, mapping rules, metadata, author details and repository paths
// are deliberately absent. Full source records may be passed; extras are stripped.
const founderStreamInputSchema = z.object({
  sources: z.array(z.object({
    id: text(256),
    sourceType: z.enum(['group_message', 'minute_transcript']),
    sourceVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    contentText: text(200_000),
    occurredAt: z.string().datetime({ offset: true }),
    availabilityStatus: z.literal('available')
  })).max(500),
  currentTopics: z.array(currentTopicSchema).max(200)
}).strict();

export type FounderEvidenceExcerpt = z.infer<typeof founderEvidenceExcerptSchema>;
export type TopicProposal = z.infer<typeof topicProposalSchema>;
export type FounderStreamAnalysis = z.infer<typeof founderStreamAnalysisSchema>;
export type FounderStreamCurrentTopic = z.infer<typeof currentTopicSchema>;
export type FounderStreamSource = Pick<ContextSourceRecord,
  'id' | 'sourceType' | 'sourceVersion' | 'contentHash' | 'contentText' | 'occurredAt' | 'availabilityStatus'>;

export interface FounderStreamInput {
  sources: readonly FounderStreamSource[];
  /** Include the immutable sources backing these excerpts in sources as well. */
  currentTopics: readonly FounderStreamCurrentTopic[];
}

export interface FounderStreamAnalyzer {
  analyze(input: FounderStreamInput): Promise<FounderStreamAnalysis>;
}

export class FounderStreamValidationError extends Error {
  constructor(readonly code: 'FOUNDER_STREAM_INPUT_INVALID' | 'FOUNDER_STREAM_OUTPUT_INVALID', readonly reason?: string) {
    super(code);
    this.name = 'FounderStreamValidationError';
  }
}

/** Return a detached, allowlisted snapshot; never forward arbitrary caller fields. */
export function validateFounderStreamInput(input: FounderStreamInput): FounderStreamInput {
  try {
    const parsed = founderStreamInputSchema.parse(input);
    assertUnique(parsed.sources.map((source) => source.id));
    assertUnique(parsed.currentTopics.map((topic) => topic.id));
    const sources = new Map(parsed.sources.map((source) => [source.id, source]));
    for (const source of parsed.sources) {
      assert(source.contentHash === sha256(source.contentText));
    }
    for (const topic of parsed.currentTopics) {
      assertExcerpts(topic.evidenceExcerpts, sources);
      assertGrounded(topic.displayName, topic.evidenceExcerpts);
      if (topic.outcome !== null) assertGrounded(topic.outcome, topic.evidenceExcerpts);
    }
    return parsed;
  } catch {
    throw new FounderStreamValidationError('FOUNDER_STREAM_INPUT_INVALID');
  }
}

/** Recheck model output at every consumer boundary, including direct service calls. */
export function validateFounderStreamAnalysis(
  output: unknown,
  input: FounderStreamInput
): FounderStreamAnalysis {
  const supplied = validateFounderStreamInput(input);
  let parsed: FounderStreamAnalysis;
  try {
    parsed = founderStreamAnalysisSchema.parse(output);
  } catch {
    throw new FounderStreamValidationError('FOUNDER_STREAM_OUTPUT_INVALID', 'schema_invalid');
  }
  try {
    const sources = new Map(supplied.sources.map((source) => [source.id, source]));
    const topics = new Map(supplied.currentTopics.map((topic) => [topic.id, topic]));
    for (const proposal of parsed.topics) {
      assertUnique(proposal.sourceIds);
      assertExcerpts(proposal.evidenceExcerpts, sources);
      const cited = new Set(proposal.evidenceExcerpts.map((evidence) => evidence.sourceId));
      assert(cited.size === proposal.sourceIds.length && proposal.sourceIds.every((id) => cited.has(id)));
      assertGrounded(proposal.displayName, proposal.evidenceExcerpts, 'display_name_ungrounded');
      if (proposal.outcome !== null) assertGrounded(proposal.outcome, proposal.evidenceExcerpts, 'outcome_ungrounded');
      if (proposal.currentAction !== null) assertGrounded(proposal.currentAction, proposal.evidenceExcerpts, 'current_action_ungrounded');
      if (proposal.stage === 'active_project') {
        assert(proposal.outcome !== null && proposal.currentAction !== null);
      }
      const join = proposal.joinDecision;
      assertUnique(join.sharedTerms);
      if (join.kind === 'new') {
        assert(join.topicId === null && join.sharedTerms.length === 0);
      } else {
        assert(join.topicId !== null);
        const target = topics.get(join.topicId);
        assert(target !== undefined);
        for (const term of join.sharedTerms) {
          assertGrounded(term, proposal.evidenceExcerpts, 'shared_term_ungrounded');
          assertGrounded(term, target.evidenceExcerpts, 'shared_term_ungrounded');
        }
      }
      assertUnique(proposal.splitSuggestions.map((split) => split.topicId));
      for (const split of proposal.splitSuggestions) {
        assert(topics.has(split.topicId));
        assert(split.topicId !== join.topicId);
      }
    }
    return parsed;
  } catch (error) {
    // Do not log or echo malformed output or source text in validation errors.
    const reason = error instanceof FounderEvidenceValidationError ? error.reason : 'evidence_invalid';
    throw new FounderStreamValidationError('FOUNDER_STREAM_OUTPUT_INVALID', reason);
  }
}

class FounderEvidenceValidationError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function assert(value: unknown, reason = 'evidence_invalid'): asserts value {
  if (!value) throw new FounderEvidenceValidationError(reason);
}

function assertUnique(values: readonly string[]): void {
  assert(new Set(values).size === values.length);
}

function assertGrounded(value: string, excerpts: readonly FounderEvidenceExcerpt[], reason = 'field_ungrounded'): void {
  assert(excerpts.some((evidence) => evidence.excerpt.includes(value)), reason);
}

function assertExcerpts(
  excerpts: readonly FounderEvidenceExcerpt[],
  sources: ReadonlyMap<string, FounderStreamSource>
): void {
  for (const evidence of excerpts) {
    const source = sources.get(evidence.sourceId);
    assert(source !== undefined && source.contentText.includes(evidence.excerpt), 'excerpt_ungrounded');
  }
}
