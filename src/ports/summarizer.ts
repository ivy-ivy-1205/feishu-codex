import { z } from 'zod';
import { todoCapabilitySchema } from '../domain/meeting.js';
import type { MinuteContext } from './feishu.js';

export const MeetingSummaryDraft = z.object({
  coreInsights: z.array(z.string().trim().min(1)).min(1),
  confirmedDecisions: z.array(z.string().trim().min(1)).min(1),
  risks: z.array(z.string().trim().min(1)).min(1),
  todos: z.array(z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    risk: z.enum(['low', 'high']),
    capability: todoCapabilitySchema
  })).min(1)
});

export type MeetingSummaryDraft = z.infer<typeof MeetingSummaryDraft>;

export interface MeetingSummarizer {
  summarize(context: MinuteContext): Promise<MeetingSummaryDraft>;
}
