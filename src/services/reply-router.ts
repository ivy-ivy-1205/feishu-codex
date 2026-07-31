import { z } from 'zod';
import {
  requiresHighRiskConfirmation,
  type ReplyDecision
} from '../domain/authorization.js';
import {
  MeetingRepository,
  type MeetingTodoRecord
} from '../repositories/meeting-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import type { ProjectDefinition } from '../domain/project.js';

const replyInputSchema = z.object({
  chatId: z.string().trim().min(1),
  openId: z.string().trim().min(1),
  replyTo: z.string().trim().min(1).nullable(),
  text: z.string().trim().min(1).max(2_000)
});

export interface ReplyRouterDependencies {
  meetingRepository: MeetingRepository;
  ivyPrivateChatId: string;
  approverOpenIds: readonly string[];
}

export function routeReply(
  input: unknown,
  dependencies: ReplyRouterDependencies
): ReplyDecision {
  const parsed = replyInputSchema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'reject', reason: 'invalid_input' };
  }
  const reply = parsed.data;

  if (!reply.openId.startsWith('ou_')) {
    return { kind: 'reject', reason: 'invalid_user_identity' };
  }
  if (dependencies.approverOpenIds.length === 0) {
    return { kind: 'identify_ivy' };
  }
  if (reply.chatId !== dependencies.ivyPrivateChatId) {
    return { kind: 'reject', reason: 'wrong_chat' };
  }
  if (!dependencies.approverOpenIds.includes(reply.openId)) {
    return { kind: 'reject', reason: 'not_ivy' };
  }

  const projectRepository = new ProjectRepository(dependencies.meetingRepository.client);
  const projects = projectRepository.listActiveProjects();
  const persistentRule = parsePersistentRule(reply.text, projects);
  if (persistentRule !== null) {
    projectRepository.createCorrectionRule({
      pattern: persistentRule.pattern,
      patternKind: 'keyword',
      projectKey: persistentRule.project.projectKey,
      subprojectKey: persistentRule.subprojectKey,
      confidenceHint: 'high',
      createdAt: new Date()
    });
    return {
      kind: 'record_project_rule',
      pattern: persistentRule.pattern,
      projectKey: persistentRule.project.projectKey,
      subprojectKey: persistentRule.subprojectKey,
      projectDisplayName: persistentRule.project.displayName,
      subprojectDisplayName: persistentRule.subprojectDisplayName,
      persistentRuleCreated: true
    };
  }
  if (reply.replyTo === null) {
    return { kind: 'clarify', reason: 'missing_reply_context' };
  }
  if (!reply.replyTo.startsWith('om_')) {
    return { kind: 'clarify', reason: 'invalid_reply_context' };
  }

  const correction = parseTodoCorrection(reply.text, reply.replyTo, dependencies.meetingRepository, projects);
  if (correction !== null) {
    if (correction.kind === 'dismiss_todo') {
      const dismissed = dependencies.meetingRepository.dismissTodo(correction.todo.id);
      return dismissed
        ? { kind: 'dismiss_todo', todoId: correction.todo.id, displayedNumber: correction.todo.displayedNumber }
        : { kind: 'clarify', reason: 'todo_not_found' };
    }

    const updated = dependencies.meetingRepository.applyTodoProjectCorrection({
      mapping: {
        todoId: correction.todo.id,
        projectKey: correction.project.projectKey,
        subprojectKey: correction.subprojectKey,
        projectConfidence: 'high',
        projectEvidence: `Ivy correction: ${reply.text}`,
        projectMappingStatus: 'mapped',
        projectPrompt: projectPrompt(correction.project, correction.subprojectDisplayName)
      },
      rule: {
        pattern: correction.todo.title,
        patternKind: 'exact',
        projectKey: correction.project.projectKey,
        subprojectKey: correction.subprojectKey,
        confidenceHint: 'high',
        createdAt: new Date()
      }
    });
    if (updated === null) {
      return { kind: 'clarify', reason: 'todo_not_found' };
    }
    return {
      kind: 'record_project_correction',
      todoId: correction.todo.id,
      displayedNumber: correction.todo.displayedNumber,
      projectKey: correction.project.projectKey,
      subprojectKey: correction.subprojectKey,
      projectDisplayName: correction.project.displayName,
      subprojectDisplayName: correction.subprojectDisplayName,
      persistentRuleCreated: true
    };
  }

  const resolution = resolveTodo(
    reply.text,
    reply.replyTo,
    dependencies.meetingRepository
  );
  if (resolution.kind !== 'resolved') {
    return { kind: 'clarify', reason: resolution.reason };
  }
  if (resolution.todo.status !== 'proposed' || resolution.todo.projectMappingStatus === 'dismissed') {
    return { kind: 'clarify', reason: 'todo_not_actionable' };
  }

  return requiresHighRiskConfirmation(resolution.todo)
    ? {
        kind: 'require_high_risk_confirmation',
        todoId: resolution.todo.id,
        todo: resolution.todo
      }
    : {
        kind: 'authorize_low_risk',
        todoId: resolution.todo.id,
        todo: resolution.todo
      };
}

const subprojectAliases = {
  'Amy Voice': 'amy-voice',
  'Amy 语音通话': 'amy-voice',
  'Amy Wechat': 'amy-wechat',
  '买家 Amy': 'amy-wechat',
  'SmartListing Amy': 'smartlisting-amy'
} as const;

interface ResolvedProject {
  project: ProjectDefinition;
  subprojectKey: string | null;
  subprojectDisplayName: string | null;
}

function parsePersistentRule(text: string, projects: ProjectDefinition[]): (ResolvedProject & { pattern: string }) | null {
  const match = normalizeCommand(text).match(/^以后\s+(.+?)\s+都归\s+(.+)$/iu);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const resolved = resolveProjectAlias(match[2], projects);
  const pattern = match[1].trim();
  return resolved && pattern ? { ...resolved, pattern } : null;
}

function parseTodoCorrection(
  text: string,
  summaryMessageId: string,
  meetingRepository: MeetingRepository,
  projects: ProjectDefinition[]
): ({ kind: 'dismiss_todo'; todo: MeetingTodoRecord } | (ResolvedProject & { kind: 'correction'; todo: MeetingTodoRecord })) | null {
  const normalized = normalizeCommand(text);
  const dismissal = normalized.match(/^(?:这条\s*)?不需要\s*Codex\s*推进\s*[:：]?\s*(?:第\s*)?([1-9]\d*)\s*(?:项|条|号)?\s*[。.!！]?$/iu)
    ?? normalized.match(/^(?:第\s*)?([1-9]\d*)\s*(?:项|条|号)?\s*不需要\s*Codex\s*推进\s*[。.!！]?$/iu);
  if (dismissal?.[1]) {
    const todo = meetingRepository.findTodoByReply(summaryMessageId, Number(dismissal[1]));
    return todo ? { kind: 'dismiss_todo', todo } : null;
  }

  const numbered = normalized.match(/^(?:第\s*)?([1-9]\d*)\s*(?:项|条|号)?\s*是\s*(.+)$/iu);
  if (numbered?.[1] && numbered[2]) {
    const todo = meetingRepository.findTodoByReply(summaryMessageId, Number(numbered[1]));
    const resolved = resolveProjectAlias(numbered[2], projects);
    return todo && resolved ? { kind: 'correction', todo, ...resolved } : null;
  }

  const replacement = normalized.match(/^不是\s+(.+?)\s*[,，]\s*是\s+(.+)$/iu);
  if (!replacement?.[1] || !replacement[2]) {
    return null;
  }
  const wrongProject = resolveProjectAlias(replacement[1], projects);
  const resolved = resolveProjectAlias(replacement[2], projects);
  if (!wrongProject || !resolved) {
    return null;
  }
  const matches = meetingRepository.listTodosByReply(summaryMessageId).filter(
    (todo) => todo.projectKey === wrongProject.project.projectKey
  );
  return matches.length === 1 ? { kind: 'correction', todo: matches[0]!, ...resolved } : null;
}

function resolveProjectAlias(value: string, projects: ProjectDefinition[]): ResolvedProject | null {
  const [projectPart, subprojectPart] = value.split('/').map((part) => part.trim());
  if (!projectPart || value.split('/').length > 2) {
    return null;
  }
  const normalizedProject = normalizeAlias(projectPart);
  const project = projects.find((candidate) => [candidate.projectKey, candidate.displayName, ...candidate.aliases]
    .some((alias) => normalizeAlias(alias) === normalizedProject));
  if (!project) {
    return null;
  }
  if (!subprojectPart) {
    return { project, subprojectKey: null, subprojectDisplayName: null };
  }
  const entry = Object.entries(subprojectAliases).find(
    ([alias]) => normalizeAlias(alias) === normalizeAlias(subprojectPart)
  );
  return entry && project.projectKey === 'realagent-ai-cc'
    ? { project, subprojectKey: entry[1], subprojectDisplayName: entry[0] }
    : null;
}

function normalizeAlias(value: string): string {
  return normalizeCommand(value).toLocaleLowerCase('en-US');
}

function projectPrompt(project: ProjectDefinition, subprojectDisplayName: string | null): string {
  return `围绕 ${project.displayName}${subprojectDisplayName ? ` / ${subprojectDisplayName}` : ''} 生成下一步项目化 Prompt。`;
}

type TodoResolution =
  | { kind: 'resolved'; todo: MeetingTodoRecord }
  | { kind: 'unresolved'; reason: 'todo_not_found' | 'ambiguous_todo' };

function resolveTodo(
  text: string,
  summaryMessageId: string,
  meetingRepository: MeetingRepository
): TodoResolution {
  const displayedNumber = parseDisplayedNumber(text);
  if (displayedNumber !== null) {
    const todo = meetingRepository.findTodoByReply(summaryMessageId, displayedNumber);
    return todo
      ? { kind: 'resolved', todo }
      : { kind: 'unresolved', reason: 'todo_not_found' };
  }

  const requestedTitle = parseExactTitle(text);
  if (requestedTitle === null) {
    return { kind: 'unresolved', reason: 'todo_not_found' };
  }
  const matches = meetingRepository.listTodosByReply(summaryMessageId).filter(
    (todo) => normalizeCommand(todo.title) === requestedTitle
  );
  if (matches.length === 1) {
    return { kind: 'resolved', todo: matches[0]! };
  }
  return {
    kind: 'unresolved',
    reason: matches.length > 1 ? 'ambiguous_todo' : 'todo_not_found'
  };
}

function parseDisplayedNumber(text: string): number | null {
  const match = normalizeCommand(text).match(
    /^(?:先\s*)?(?:干|做|执行|推进)\s*(?:todo\s*)?#?\s*(?:第\s*)?([1-9]\d*)\s*(?:个|项|号|条)?\s*[。.!！]?$/iu
  );
  if (!match?.[1]) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function parseExactTitle(text: string): string | null {
  const normalized = normalizeCommand(text).replace(/[。.!！]$/u, '').trim();
  const prefixed = normalized.match(/^(?:先\s*)?(?:干|做|执行|推进)\s+(.+)$/u);
  const title = (prefixed?.[1] ?? normalized).trim();
  return title && !/\d/u.test(title) ? title : null;
}

function normalizeCommand(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
