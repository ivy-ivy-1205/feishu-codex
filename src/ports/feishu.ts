import { z } from 'zod';
import { TranscriptSegment } from '../domain/meeting.js';

export const MinuteContext = z.object({
  minuteId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  transcript: z.array(TranscriptSegment).min(1)
}).refine((context) => context.endedAt >= context.startedAt, {
  message: 'endedAt must be greater than or equal to startedAt',
  path: ['endedAt']
});

export type MinuteContext = z.infer<typeof MinuteContext>;

export interface FeishuMinuteReadOptions {
  subscriberOpenIds?: string[];
}

export type FeishuUserAccessTokenResolution =
  | {
    status: 'available';
    openId: string;
    userAccessToken: string;
  }
  | {
    status: 'unavailable';
    reason:
      | 'oauth_disabled'
      | 'missing'
      | 'ambiguous'
      | 'reauthorization_required';
  };

export interface FeishuUserAccessTokenResolver {
  resolveUserAccessToken(input: {
    candidateOpenIds: string[];
  }): Promise<FeishuUserAccessTokenResolution>;
}

export interface FeishuMinutesReader {
  getMinute(minuteId: string, options?: FeishuMinuteReadOptions): Promise<MinuteContext>;
}
