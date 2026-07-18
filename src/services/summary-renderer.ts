const messageSizeLimitBytes = 28_000;

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
  capability: 'codex' | 'human_only';
}

export function renderMeetingSummary(
  summary: MeetingSummaryRenderInput,
  todos: readonly MeetingTodoRenderInput[]
): string {
  const coreInsights = summary.coreInsights.map((insight) => insight.trim());
  if (coreInsights.length === 0 || coreInsights.some((insight) => insight.length === 0)) {
    throw new Error('core insights must not be empty');
  }
  if (todos.length > 5) {
    throw new Error('meeting summary can contain at most five Todo items');
  }
  if (todos.some((todo) => todo.capability === 'human_only')) {
    throw new Error('human_only capability cannot be offered as executable');
  }

  const displayedNumbers = todos.map((todo) => todo.displayedNumber);
  if (new Set(displayedNumbers).size !== displayedNumbers.length) {
    throw new Error('Todo displayed numbers must be unique');
  }

  const sortedTodos = [...todos].sort(
    (left, right) => left.displayedNumber - right.displayedNumber
  );
  const coreInformation = [
    ...coreInsights.map((insight) => `• ${insight}`),
    ...summary.confirmedDecisions.map((decision) => `• 已确认：${decision.trim()}`),
    ...summary.risks.map((risk) => `• 风险：${risk.trim()}`)
  ];
  const text = [
    `${summary.title.trim()}｜个性化会后总结`,
    `会议：${summary.title.trim()}`,
    `时间：${summary.startedAt.trim()} - ${summary.endedAt.trim()}`,
    '',
    '核心信息',
    ...coreInformation,
    '',
    '我可以帮你推进',
    ...sortedTodos.map((todo) => `${todo.displayedNumber}. ${todo.title.trim()}`)
  ].join('\n');

  if (Buffer.byteLength(text, 'utf8') >= messageSizeLimitBytes) {
    throw new Error('meeting summary exceeds the 28,000-byte safety limit');
  }
  return text;
}
