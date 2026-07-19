import { z } from 'zod';
import {
  requiresHighRiskConfirmation,
  type ReplyDecision
} from '../domain/authorization.js';
import {
  MeetingRepository,
  type MeetingTodoRecord
} from '../repositories/meeting-repository.js';

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
  if (reply.replyTo === null) {
    return { kind: 'clarify', reason: 'missing_reply_context' };
  }
  if (!reply.replyTo.startsWith('om_')) {
    return { kind: 'clarify', reason: 'invalid_reply_context' };
  }

  const resolution = resolveTodo(
    reply.text,
    reply.replyTo,
    dependencies.meetingRepository
  );
  if (resolution.kind !== 'resolved') {
    return { kind: 'clarify', reason: resolution.reason };
  }
  if (resolution.todo.status !== 'proposed') {
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
