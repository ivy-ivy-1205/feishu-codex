import { z } from 'zod';
import { todoCapabilitySchema } from '../domain/meeting.js';
import type { MinuteContext } from './feishu.js';

const summaryOutputLimitBytes = 64 * 1024;
const summaryItemLimitBytes = 8 * 1024;
const todoTitleLimitBytes = 512;
const todoDescriptionLimitBytes = 4 * 1024;

function boundedText(label: string, maximumBytes: number) {
  return z.string().trim().min(1).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
    `${label} exceeds ${maximumBytes} UTF-8 bytes`
  );
}

export const MeetingSummaryDraft = z.object({
  coreInsights: z.array(boundedText('core insight', summaryItemLimitBytes)).min(1).max(20),
  confirmedDecisions: z.array(
    boundedText('confirmed decision', summaryItemLimitBytes)
  ).max(20),
  risks: z.array(boundedText('risk', summaryItemLimitBytes)).max(20),
  todos: z.array(z.object({
    title: boundedText('Todo title', todoTitleLimitBytes),
    description: boundedText('Todo description', todoDescriptionLimitBytes),
    risk: z.enum(['low', 'high']),
    capability: todoCapabilitySchema
  })).max(5)
}).superRefine((draft, context) => {
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > summaryOutputLimitBytes) {
    context.addIssue({
      code: 'custom',
      message: `structured summary exceeds ${summaryOutputLimitBytes} UTF-8 bytes`
    });
  }
});

export type MeetingSummaryDraft = z.infer<typeof MeetingSummaryDraft>;

export class SummarizerOutputValidationError extends Error {
  readonly code = 'SUMMARIZER_OUTPUT_INVALID';

  constructor() {
    super('structured summarizer output is invalid');
    this.name = 'SummarizerOutputValidationError';
  }
}

export function parseMeetingSummaryDraft(input: unknown): MeetingSummaryDraft {
  const parsed = MeetingSummaryDraft.safeParse(input);
  if (!parsed.success) {
    throw new SummarizerOutputValidationError();
  }
  return parsed.data;
}

export interface MeetingSummarizer {
  summarize(context: MinuteContext): Promise<MeetingSummaryDraft>;
}
