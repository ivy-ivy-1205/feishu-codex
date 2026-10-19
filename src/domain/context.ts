import { z } from 'zod';

export const contextCandidateTypeSchema = z.enum([
  'proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker',
  'requirement', 'status_update', 'action_item'
]);
export const contextScopeSchema = z.enum(['company', 'project']);
export const contextFactualStatusSchema = z.enum([
  'source_attested', 'reported', 'reviewer_confirmed', 'evidence_verified', 'disputed'
]);
export const contextReviewStatusSchema = z.enum([
  'pending', 'approved', 'rejected', 'needs_clarification', 'conflict'
]);
export const contextRelationTypeSchema = z.enum([
  'supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates'
]);
export const contextEvidenceLevelSchema = z.enum([
  'derived_summary', 'primary_statement', 'authoritative_record', 'direct_observation'
]);
export const contextEvidenceRoleSchema = z.enum(['supporting', 'contradicting', 'context']);
export const contextSourceRelationTypeSchema = z.enum(['derived_from', 'part_of', 'revises']);
export const contextExtractionSourceRoleSchema = z.enum(['primary', 'context']);
export const contextProjectConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const contextProjectRoleSchema = z.enum(['primary', 'related']);
export const contextProjectMappingStatusSchema = z.enum([
  'mapped', 'needs_confirmation', 'unmapped', 'conflict'
]);

const transcriptEvidenceLocatorFields = {
  segmentOrdinal: z.number().int().nonnegative(),
  sourceVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  speakerName: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative()
} as const;

function validateMinuteRange(locator: { startMs: number; endMs: number }, context: z.RefinementCtx): void {
  if (locator.endMs < locator.startMs) {
    context.addIssue({ code: 'custom', path: ['endMs'], message: 'endMs must not precede startMs' });
  }
}

export const transcriptEvidenceLocatorSchema = z.object(transcriptEvidenceLocatorFields)
  .strict().superRefine(validateMinuteRange);

export const minuteSegmentEvidenceLocatorSchema = z.object({
  kind: z.literal('minute_segment'),
  ...transcriptEvidenceLocatorFields
}).strict().superRefine(validateMinuteRange);

export const groupMessageEvidenceLocatorSchema = z.object({
  kind: z.literal('group_message'),
  sourceVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  threadId: z.string().trim().min(1).nullable(),
  authorOpenId: z.string().trim().min(1).nullable(),
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export const spacePageBlockEvidenceLocatorSchema = z.object({
  kind: z.literal('space_page_block'),
  sourceVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  pageId: z.string().trim().min(1),
  blockId: z.string().trim().min(1),
  blockHash: z.string().regex(/^[a-f0-9]{64}$/),
  blockOrdinal: z.number().int().nonnegative()
}).strict();

export const spaceCommentEvidenceLocatorSchema = z.object({
  kind: z.literal('space_comment'),
  sourceVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  pageId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  authorOpenId: z.string().trim().min(1).nullable(),
  targetBlockId: z.string().trim().min(1).nullable()
}).strict();

const discriminatedContextEvidenceLocatorSchema = z.discriminatedUnion('kind', [
  minuteSegmentEvidenceLocatorSchema,
  groupMessageEvidenceLocatorSchema,
  spacePageBlockEvidenceLocatorSchema,
  spaceCommentEvidenceLocatorSchema
]);

function withLegacyMinuteKind(locator: unknown): unknown {
  if (locator && typeof locator === 'object' && !Array.isArray(locator) &&
    !Object.prototype.hasOwnProperty.call(locator, 'kind')) {
    return { ...locator, kind: 'minute_segment' };
  }
  return locator;
}

export const contextEvidenceLocatorSchema = z.preprocess(
  withLegacyMinuteKind,
  discriminatedContextEvidenceLocatorSchema
);

export const initialFactualStatusByCandidateType = {
  proposal: 'source_attested', decision: 'source_attested', requirement: 'source_attested',
  action_item: 'source_attested', reported_progress: 'reported', claim: 'reported',
  status_update: 'reported', risk: 'reported', blocker: 'reported'
} as const satisfies Record<z.infer<typeof contextCandidateTypeSchema>, 'source_attested' | 'reported'>;

export function initialFactualStatusFor(
  candidateType: z.infer<typeof contextCandidateTypeSchema>
): 'source_attested' | 'reported' {
  return initialFactualStatusByCandidateType[candidateType];
}

export const contextCandidateSchema = z.object({
  candidateType: contextCandidateTypeSchema,
  scope: contextScopeSchema,
  summary: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1).nullable(),
  structuredPayload: z.record(z.string(), z.unknown()),
  extractionConfidence: z.number().min(0).max(1),
  factualStatus: contextFactualStatusSchema,
  reviewStatus: contextReviewStatusSchema,
  suggestedRelation: contextRelationTypeSchema.optional()
}).strict();

export type ContextCandidateType = z.infer<typeof contextCandidateTypeSchema>;
export type ContextScope = z.infer<typeof contextScopeSchema>;
export type ContextFactualStatus = z.infer<typeof contextFactualStatusSchema>;
export type ContextReviewStatus = z.infer<typeof contextReviewStatusSchema>;
export type ContextRelationType = z.infer<typeof contextRelationTypeSchema>;
export type ContextEvidenceLevel = z.infer<typeof contextEvidenceLevelSchema>;
export type ContextEvidenceRole = z.infer<typeof contextEvidenceRoleSchema>;
export type ContextSourceRelationType = z.infer<typeof contextSourceRelationTypeSchema>;
export type ContextExtractionSourceRole = z.infer<typeof contextExtractionSourceRoleSchema>;
export type ContextProjectConfidence = z.infer<typeof contextProjectConfidenceSchema>;
export type ContextProjectRole = z.infer<typeof contextProjectRoleSchema>;
export type ContextProjectMappingStatus = z.infer<typeof contextProjectMappingStatusSchema>;
export type MinuteSegmentEvidenceLocator = z.infer<typeof minuteSegmentEvidenceLocatorSchema>;
export type GroupMessageEvidenceLocator = z.infer<typeof groupMessageEvidenceLocatorSchema>;
export type SpacePageBlockEvidenceLocator = z.infer<typeof spacePageBlockEvidenceLocatorSchema>;
export type SpaceCommentEvidenceLocator = z.infer<typeof spaceCommentEvidenceLocatorSchema>;
export type ContextEvidenceLocator = z.infer<typeof contextEvidenceLocatorSchema>;
export type TranscriptEvidenceLocator = z.infer<typeof transcriptEvidenceLocatorSchema>;
export type ContextEvidenceLocatorInput = ContextEvidenceLocator | TranscriptEvidenceLocator;
