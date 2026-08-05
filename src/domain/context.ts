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

export const transcriptEvidenceLocatorSchema = z.object({
  segmentOrdinal: z.number().int().nonnegative(),
  sourceVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  speakerName: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative()
}).strict().superRefine((locator, context) => {
  if (locator.endMs < locator.startMs) {
    context.addIssue({ code: 'custom', path: ['endMs'], message: 'endMs must not precede startMs' });
  }
});

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
export type TranscriptEvidenceLocator = z.infer<typeof transcriptEvidenceLocatorSchema>;
