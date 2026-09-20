import { z } from 'zod';

export const projectConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const projectMappingStatusSchema = z.enum([
  'mapped',
  'needs_confirmation',
  'unmapped',
  'dismissed'
]);
export const projectRuleSourceSchema = z.enum(['system', 'ivy_correction']);
export const projectRulePatternKindSchema = z.enum(['keyword', 'exact', 'regex']);
export const projectStatusSchema = z.enum(['active', 'archived']);
export const projectOriginSchema = z.enum(['discovered', 'human_confirmed', 'legacy_seed']);
export const projectStageSchema = z.enum([
  'idea',
  'exploring',
  'project_candidate',
  'active_project',
  'paused',
  'closed'
]);

export const ProjectKey = z.string().min(1);
export type ProjectKey = z.infer<typeof ProjectKey>;

export const ProjectDefinition = z.object({
  projectKey: ProjectKey,
  displayName: z.string().min(1),
  aliases: z.array(z.string().min(1)).readonly(),
  localPathHint: z.string().min(1).nullable(),
  repoUrl: z.string().url().nullable(),
  defaultBranch: z.string().min(1).nullable(),
  status: projectStatusSchema,
  origin: projectOriginSchema,
  stage: projectStageSchema
});
export type ProjectDefinition = z.infer<typeof ProjectDefinition>;
export type ProjectOrigin = z.infer<typeof projectOriginSchema>;
export type ProjectStage = z.infer<typeof projectStageSchema>;

export const ProjectMappingRule = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  patternKind: projectRulePatternKindSchema,
  projectKey: ProjectKey,
  subprojectKey: z.string().min(1).nullable(),
  confidenceHint: projectConfidenceSchema,
  priority: z.number().int(),
  source: projectRuleSourceSchema,
  active: z.boolean()
});
export type ProjectMappingRule = z.infer<typeof ProjectMappingRule>;

export const ProjectMappingDraft = z.object({
  projectKey: ProjectKey.nullable(),
  subprojectKey: z.string().min(1).nullable(),
  confidence: projectConfidenceSchema,
  evidence: z.string(),
  status: projectMappingStatusSchema,
  projectPrompt: z.string(),
  conflict: z.object({
    existingProjectKey: ProjectKey,
    candidateProjectKey: ProjectKey,
    candidateConfidence: projectConfidenceSchema,
    candidateEvidence: z.string().min(1)
  }).nullable().default(null)
});
export type ProjectMappingDraft = z.infer<typeof ProjectMappingDraft>;

export type ProjectMappingStatus = z.infer<typeof projectMappingStatusSchema>;
export type ProjectConfidence = z.infer<typeof projectConfidenceSchema>;
