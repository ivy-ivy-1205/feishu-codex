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
  oneLineConclusion: string;
  progress: readonly string[];
  decisions: readonly string[];
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
  const title = normalizeLine(summary.title, 'meeting title');
  const oneLineConclusion = normalizeLine(
    summary.oneLineConclusion,
    'one line conclusion'
  );
  const progress = summary.progress.map(
    (item) => normalizeLine(item, 'progress')
  );
  const decisions = summary.decisions.map(
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
  const todoLines = sortedTodos.length > 0
    ? sortedTodos.map((todo) => (
      `${todo.displayedNumber}. ${normalizeLine(todo.title, 'Todo title')}`
    ))
    : ['暂无可由 Codex 直接推进的事项。'];
  const text = [
    `${title}｜会后行动摘要`,
    `会议：${title}`,
    '时间',
    `北京时间：${formatTimeRange(summary.startedAt, summary.endedAt, 'Asia/Shanghai')}`,
    `悉尼时间：${formatTimeRange(summary.startedAt, summary.endedAt, 'Australia/Sydney')}`,
    '',
    '一句话结论',
    oneLineConclusion,
    '',
    ...renderSection('进展', progress),
    ...renderSection('已确认', decisions),
    ...renderSection('风险/卡点', risks),
    '',
    '我可以帮你推进',
    ...todoLines
  ].join('\n');

  if (Buffer.byteLength(text, 'utf8') >= messageSizeLimitBytes) {
    throw new MeetingSummaryRenderError(
      'meeting summary exceeds the 28,000-byte safety limit'
    );
  }
  return text;
}

function renderSection(title: string, items: readonly string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return [
    title,
    ...items.map((item) => `• ${item}`),
    ''
  ];
}

function formatTimeRange(startedAt: string, endedAt: string, timeZone: string): string {
  const start = parseDate(startedAt, 'meeting start time');
  const end = parseDate(endedAt, 'meeting end time');
  const startParts = dateTimeParts(start, timeZone);
  const endParts = dateTimeParts(end, timeZone);
  const startDate = `${startParts.year}-${startParts.month}-${startParts.day}`;
  const endDate = `${endParts.year}-${endParts.month}-${endParts.day}`;
  const startTime = `${startParts.hour}:${startParts.minute}`;
  const endTime = `${endParts.hour}:${endParts.minute}`;
  return startDate === endDate
    ? `${startDate} ${startTime}–${endTime}`
    : `${startDate} ${startTime}–${endDate} ${endTime}`;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MeetingSummaryRenderError(`${label} must be a valid datetime`);
  }
  return date;
}

function dateTimeParts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
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
