import {
  ProjectMappingDraft,
  type ProjectConfidence,
  type ProjectDefinition,
  type ProjectMappingRule
} from '../domain/project.js';

export interface MapTodoToProjectInput {
  title: string;
  description: string;
  proposedProjectKey: string | null;
  proposedSubprojectKey: string | null;
  proposedConfidence: ProjectConfidence;
  proposedEvidence: string;
  proposedProjectPrompt: string;
}

export interface ProjectRegistry {
  projects: readonly ProjectDefinition[];
  rules: readonly ProjectMappingRule[];
  contextSnapshots: readonly unknown[];
}

export function mapTodoToProject(
  input: MapTodoToProjectInput,
  registry: ProjectRegistry
) {
  const activeProjects = registry.projects.filter((project) => project.status === 'active');
  const normalizedTitle = normalize(input.title);
  const matchingText = normalize(`${input.title}\n${input.description}`);

  for (const source of ['ivy_correction', 'system'] as const) {
    const rules = registry.rules
      .filter((rule) => rule.active && rule.source === source)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const matchingRule = rules.find((rule) => matches(rule, normalizedTitle, matchingText));
    if (matchingRule && activeProjects.some((project) => project.projectKey === matchingRule.projectKey)) {
      const hasConflictingHighConfidenceProposal = input.proposedConfidence === 'high'
        && input.proposedEvidence.trim().length > 0
        && input.proposedProjectKey !== null
        && input.proposedProjectKey !== matchingRule.projectKey
        && activeProjects.some((project) => project.projectKey === input.proposedProjectKey);
      return ProjectMappingDraft.parse({
        projectKey: matchingRule.projectKey,
        subprojectKey: matchingRule.subprojectKey,
        confidence: matchingRule.confidenceHint,
        evidence: `${matchingRule.source}:${matchingRule.id} matched ${matchingRule.pattern}`,
        status: 'mapped',
        projectPrompt: input.proposedProjectPrompt,
        conflict: hasConflictingHighConfidenceProposal
          ? {
              existingProjectKey: matchingRule.projectKey,
              candidateProjectKey: input.proposedProjectKey,
              candidateConfidence: input.proposedConfidence,
              candidateEvidence: input.proposedEvidence
            }
          : null
      });
    }
  }

  if (input.proposedProjectKey && activeProjects.some((project) => project.projectKey === input.proposedProjectKey)) {
    return ProjectMappingDraft.parse({
      projectKey: input.proposedProjectKey,
      subprojectKey: input.proposedSubprojectKey,
      confidence: input.proposedConfidence,
      evidence: input.proposedEvidence,
      status: input.proposedConfidence === 'low' ? 'needs_confirmation' : 'mapped',
      projectPrompt: input.proposedProjectPrompt,
      conflict: null
    });
  }

  return ProjectMappingDraft.parse({
    projectKey: null,
    subprojectKey: null,
    confidence: 'low',
    evidence: '',
    status: 'needs_confirmation',
    projectPrompt: input.proposedProjectPrompt,
    conflict: null
  });
}

function matches(
  rule: ProjectMappingRule,
  normalizedTitle: string,
  normalizedText: string
): boolean {
  if (rule.patternKind === 'keyword') {
    return normalizedText.includes(normalize(rule.pattern));
  }
  if (rule.patternKind === 'exact') {
    return normalizedTitle === normalize(rule.pattern);
  }
  try {
    return new RegExp(rule.pattern, 'iu').test(normalizedText);
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
