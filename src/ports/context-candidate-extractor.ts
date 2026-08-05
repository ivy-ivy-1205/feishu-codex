import { z } from 'zod';
import {
  contextCandidateTypeSchema, contextEvidenceRoleSchema, contextProjectConfidenceSchema,
  contextProjectRoleSchema, contextRelationTypeSchema, contextScopeSchema,
  initialFactualStatusFor, transcriptEvidenceLocatorSchema
} from '../domain/context.js';
import type { ContextSourceRecord } from '../repositories/context-source-repository.js';
import type { ProjectContextCard } from '../services/project-context.js';

const projectMappingSchema = z.object({
  projectKey: z.string().trim().min(1).nullable(),
  role: contextProjectRoleSchema,
  confidence: contextProjectConfidenceSchema,
  evidence: z.string().trim().min(1).max(1024)
}).strict();
const evidenceSchema = z.object({
  sourceId: z.string().trim().min(1),
  excerpt: z.string().trim().min(1).max(4000),
  locator: transcriptEvidenceLocatorSchema,
  evidenceLevel: z.enum(['primary_statement', 'derived_summary']),
  role: contextEvidenceRoleSchema
}).strict();
const relationSchema = z.object({
  recordId: z.string().trim().min(1),
  relationType: contextRelationTypeSchema,
  rationale: z.string().trim().min(1).max(1024)
}).strict();
export const extractedContextCandidateSchema = z.object({
  candidateType: contextCandidateTypeSchema,
  scope: contextScopeSchema,
  summary: z.string().trim().min(1).max(2000),
  subjectKey: z.string().trim().min(1).nullable(),
  structuredPayload: z.record(z.string(), z.unknown()),
  extractionConfidence: z.number().min(0).max(1),
  factualStatus: z.enum(['source_attested', 'reported']),
  projectMappings: z.array(projectMappingSchema).max(10),
  evidence: z.array(evidenceSchema).min(1).max(20),
  suggestedRelations: z.array(relationSchema).max(10),
  externalRefs: z.array(z.record(z.string(), z.unknown())).max(20)
}).strict().superRefine((candidate, context) => {
  if (!candidate.evidence.some((item) => item.role === 'supporting')) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'supporting evidence is required' });
  }
  if (candidate.scope === 'project' && !candidate.projectMappings.some((mapping) =>
    mapping.role === 'primary' && mapping.projectKey !== null)) {
    context.addIssue({ code: 'custom', path: ['projectMappings'], message: 'project scope requires a primary project proposal' });
  }
  if (candidate.factualStatus !== initialFactualStatusFor(candidate.candidateType)) {
    context.addIssue({ code: 'custom', path: ['factualStatus'],
      message: 'candidate type and initial factual status do not match the locked mapping' });
  }
});
export const contextCandidateExtractorOutputSchema = z.object({
  candidates: z.array(extractedContextCandidateSchema).max(12)
}).strict();

export type ContextCandidateExtractorOutput = z.infer<typeof contextCandidateExtractorOutputSchema>;
export interface ContextRecordSummary { id: string; type: string; scope: string; summary: string; factualStatus: string }
export interface ContextCandidateExtractor {
  extract(input: {
    sources: readonly ContextSourceRecord[];
    projects: readonly ProjectContextCard[];
    existingRecords: readonly ContextRecordSummary[];
  }): Promise<ContextCandidateExtractorOutput>;
}
