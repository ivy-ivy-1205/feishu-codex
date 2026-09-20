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
