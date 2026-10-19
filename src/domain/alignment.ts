import { z } from 'zod';

export const founderRoleSchema = z.enum(['ivy', 'james']);

export const perspectiveKindSchema = z.enum([
  'ivy_view',
  'james_view',
  'shared_decision',
  'unresolved'
]);

export const perspectiveSpeechActSchema = z.enum([
  'view',
  'decision_proposal',
  'explicit_agreement',
  'explicit_disagreement'
]);

export type FounderRole = z.infer<typeof founderRoleSchema>;
export type PerspectiveKind = z.infer<typeof perspectiveKindSchema>;
export type PerspectiveSpeechAct = z.infer<typeof perspectiveSpeechActSchema>;

export interface FounderIdentity {
  id: string;
  founder: FounderRole;
  sourceSystem: string;
  externalAuthorId: string;
  configuredAt: string;
}

export interface PerspectiveVersion {
  id: string;
  perspectiveId: string;
  topicId: string;
  kind: PerspectiveKind;
  versionNumber: number;
  statement: string;
  confidence: number;
  evidenceIds: readonly string[];
  decisionKey: string | null;
  speechAct: PerspectiveSpeechAct;
  observedAt: string;
}

export interface CurrentPerspective extends PerspectiveVersion {
  createdAt: string;
  updatedAt: string;
}

export const alignmentIssueStatusSchema = z.enum(['candidate', 'ready', 'asked', 'resolved', 'dismissed', 'stale']);
export const alignmentDimensionSchema = z.enum(['direction', 'next_action', 'owner', 'deadline', 'completion_standard']);
const evidenceStatementSchema = z.object({ evidenceId: z.string().trim().min(1), statement: z.string().trim().min(1).max(2000) }).strict();
const actionEvidenceSchema = z.object({ evidenceId: z.string().trim().min(1), excerpt: z.string().trim().min(1).max(2000) }).strict();
export const alignmentProposalSchema = z.object({
  topicId: z.string().trim().min(1), decisionKey: z.string().trim().min(1), dimension: alignmentDimensionSchema,
  ivy: evidenceStatementSchema, james: evidenceStatementSchema,
  actionConsequence: actionEvidenceSchema.nullable(),
  actionHorizon: actionEvidenceSchema.extend({ startsAt: z.string().datetime(), endsAt: z.string().datetime() }).nullable()
}).strict();
export type AlignmentIssueStatus = z.infer<typeof alignmentIssueStatusSchema>;
export type AlignmentProposal = z.infer<typeof alignmentProposalSchema>;
export interface AlignmentCandidate extends AlignmentProposal {
  id: string;
  status: 'candidate';
  evidenceIds: string[];
  evidenceSetHash: string;
}
export interface AlignmentIssue extends Omit<AlignmentCandidate, 'status'> {
  status: AlignmentIssueStatus;
  createdAt: string;
  updatedAt: string;
  deliveredMessageId: string | null;
}
