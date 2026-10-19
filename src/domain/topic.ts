import { z } from 'zod';

export const topicStageSchema = z.enum([
  'idea',
  'exploring',
  'project_candidate',
  'active_project',
  'paused',
  'closed'
]);

export const topicRelationTypeSchema = z.enum([
  'same_as',
  'split_from',
  'part_of',
  'related_to',
  'supersedes'
]);

export type TopicStage = z.infer<typeof topicStageSchema>;
export type TopicRelationType = z.infer<typeof topicRelationTypeSchema>;

export interface TopicVersion {
  id: string;
  topicId: string;
  versionNumber: number;
  displayName: string;
  stage: TopicStage;
  outcome: string | null;
  rationale: string;
  evidenceIds: readonly string[];
  changedAt: string;
}

export interface CurrentTopic {
  id: string;
  currentVersionId: string;
  currentVersion: number;
  displayName: string;
  stage: TopicStage;
  outcome: string | null;
  rationale: string;
  evidenceIds: readonly string[];
  changedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicSourceLink {
  id: string;
  topicId: string;
  topicVersion: number;
  sourceId: string;
  evidenceId: string | null;
  addedAt: string;
}

export interface TopicRelation {
  id: string;
  fromTopicId: string;
  fromVersionNumber: number;
  toTopicId: string;
  toVersionNumber: number;
  relationType: TopicRelationType;
  rationale: string;
  createdAt: string;
}
