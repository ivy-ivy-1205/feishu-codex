import type { MeetingTodoDraft, TodoCapability } from './meeting.js';

export const highRiskCapabilities = [
  'code_write',
  'external_message',
  'deploy',
  'delete',
  'production_access'
] as const;

export type HighRiskCapability = typeof highRiskCapabilities[number];
export const safeTodoCapabilities = ['content_draft'] as const satisfies readonly TodoCapability[];

export type ReplyDecision =
  | TodoReplyDecision<'authorize_low_risk'>
  | TodoReplyDecision<'require_high_risk_confirmation'>
  | { kind: 'identify_ivy' }
  | { kind: 'clarify'; reason: ClarificationReason }
  | { kind: 'reject'; reason: RejectionReason };

export type ClarificationReason =
  | 'missing_reply_context'
  | 'invalid_reply_context'
  | 'todo_not_found'
  | 'ambiguous_todo'
  | 'todo_not_actionable';

export type RejectionReason =
  | 'invalid_input'
  | 'wrong_chat'
  | 'invalid_user_identity'
  | 'not_ivy';

interface TodoReplyDecision<Kind extends string> {
  kind: Kind;
  todoId: string;
  todo: ReplyTodo;
}

export interface ReplyTodo extends MeetingTodoDraft {
  summaryId: string;
  createdAt: string;
}

export function requiresHighRiskConfirmation(input: {
  risk: 'low' | 'high';
  capability?: unknown;
}): boolean {
  return input.risk !== 'low' || !safeTodoCapabilities.some(
    (capability) => capability === input.capability
  );
}
