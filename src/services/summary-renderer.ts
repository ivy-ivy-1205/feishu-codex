import type { TodoCapability } from '../domain/meeting.js';

const messageSizeLimitBytes = 28_000;

export class MeetingSummaryRenderError extends Error {
  readonly code = 'SUMMARY_RENDER_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'MeetingSummaryRenderError';
  }
}

export interface MeetingSummaryRenderInput {
  title: string;
  startedAt: string;
  endedAt: string;
  coreInsights: readonly string[];
  confirmedDecisions: readonly string[];
  risks: readonly string[];
}

export interface MeetingTodoRenderInput {
  displayedNumber: number;
  title: string;
  capability: TodoCapability | 'human_only';
}

export function renderMeetingSummary(
  summary: MeetingSummaryRenderInput,
  todos: readonly MeetingTodoRenderInput[]
): string {
  if (summary.coreInsights.length === 0) {
    throw new MeetingSummaryRenderError('core insights must not be empty');
  }
  const title = normalizeLine(summary.title, 'meeting title');
  const startedAt = normalizeLine(summary.startedAt, 'meeting start time');
  const endedAt = normalizeLine(summary.endedAt, 'meeting end time');
  const coreInsights = summary.coreInsights.map(
    (insight) => normalizeLine(insight, 'core insights')
  );
  const confirmedDecisions = summary.confirmedDecisions.map(
    (decision) => normalizeLine(decision, 'confirmed decision')
  );
  const risks = summary.risks.map((risk) => normalizeLine(risk, 'risk'));
  if (todos.length > 5) {
    throw new MeetingSummaryRenderError(
      'meeting summary can contain at most five Todo items'
    );
  }
  if (todos.some((todo) => (
    todo.capability === 'human_only' || todo.capability === 'unknown'
  ))) {
    throw new MeetingSummaryRenderError(
      'unknown or human_only capability cannot be offered as executable'
    );
  }

  const displayedNumbers = todos.map((todo) => todo.displayedNumber);
  if (new Set(displayedNumbers).size !== displayedNumbers.length) {
    throw new MeetingSummaryRenderError('Todo displayed numbers must be unique');
  }

  const sortedTodos = [...todos].sort(
    (left, right) => left.displayedNumber - right.displayedNumber
  );
  const coreInformation = [
    ...coreInsights.map((insight) => `• ${insight}`),
    ...confirmedDecisions.map((decision) => `• 已确认：${decision}`),
    ...risks.map((risk) => `• 风险：${risk}`)
  ];
  const text = [
    `${title}｜个性化会后总结`,
    `会议：${title}`,
    `时间：${startedAt} - ${endedAt}`,
    '',
    '核心信息',
    ...coreInformation,
    '',
    '我可以帮你推进',
    ...sortedTodos.map((todo) => (
      `${todo.displayedNumber}. ${normalizeLine(todo.title, 'Todo title')}`
    ))
  ].join('\n');

  if (Buffer.byteLength(text, 'utf8') >= messageSizeLimitBytes) {
    throw new MeetingSummaryRenderError(
      'meeting summary exceeds the 28,000-byte safety limit'
    );
  }
  return text;
}

function normalizeLine(value: string, label: string): string {
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) {
    throw new MeetingSummaryRenderError(`${label} must not be empty`);
  }
  return normalized;
}
