import { z } from 'zod';

export const todoRiskSchema = z.enum(['low', 'high']);
export const todoCapabilitySchema = z.enum([
  'unknown',
  'content_draft',
  'code_write',
  'external_message',
  'deploy',
  'delete',
  'production_access'
]);
export const todoStatusSchema = z.enum([
  'proposed',
  'authorized',
  'running',
  'completed',
  'failed',
  'needs_confirmation'
]);

export const MinuteGeneratedEvent = z.object({
  eventId: z.string().trim().min(1),
  minuteId: z.string().trim().min(1),
  occurredAt: z.string().datetime()
});

export const TranscriptSegment = z.object({
  speakerName: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().trim().min(1)
}).refine((segment) => segment.endMs >= segment.startMs, {
  message: 'endMs must be greater than or equal to startMs',
  path: ['endMs']
});

export const MeetingTodoDraft = z.object({
  id: z.string().trim().min(1),
  displayedNumber: z.number().int().positive(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  risk: todoRiskSchema,
  capability: todoCapabilitySchema,
  status: todoStatusSchema.default('proposed')
});

export const MeetingSummaryDraft = z.object({
  id: z.string().trim().min(1),
  minuteId: z.string().trim().min(1),
  summaryMessageId: z.string().trim().min(1),
  content: z.string().trim().min(1),
  todos: z.array(MeetingTodoDraft)
});

export type MinuteGeneratedEvent = z.infer<typeof MinuteGeneratedEvent>;
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;
export type MeetingTodoDraft = z.infer<typeof MeetingTodoDraft>;
export type TodoCapability = z.infer<typeof todoCapabilitySchema>;
export type MeetingSummaryDraft = z.infer<typeof MeetingSummaryDraft>;
