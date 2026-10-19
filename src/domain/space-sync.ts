import { z } from 'zod';

export const spaceSyncTriggerSchema = z.enum(['manual', 'scheduled', 'event']);

export const spaceSyncBlockSchema = z.object({
  id: z.string().trim().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  markdown: z.string()
}).strict();

export const spaceSyncGapSchema = z.object({
  code: z.string().trim().min(1),
  summary: z.string().trim().min(1)
}).strict();

export const spaceSyncCoverageSchema = z.object({
  pageComplete: z.boolean(),
  commentsComplete: z.boolean(),
  nextCursor: z.string().trim().min(1).nullable(),
  gaps: z.array(spaceSyncGapSchema)
}).strict();

export const spaceSyncPageSchema = z.object({
  pageId: z.string().trim().min(1),
  spaceId: z.string().trim().min(1).nullable(),
  url: z.string().trim().url(),
  title: z.string().trim().min(1),
  sequence: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  blocks: z.array(spaceSyncBlockSchema)
}).strict();

function validateCommentResolution(
  comment: { threadState: 'open' | 'resolved'; resolvedAt: string | null },
  context: z.RefinementCtx
): void {
  if (comment.threadState === 'open' && comment.resolvedAt !== null) {
    context.addIssue({ code: 'custom', path: ['resolvedAt'], message: 'resolvedAt must be null while threadState is open' });
  }
  if (comment.threadState === 'resolved' && comment.resolvedAt === null) {
    context.addIssue({ code: 'custom', path: ['resolvedAt'], message: 'resolvedAt is required once threadState is resolved' });
  }
}

export const spaceSyncCommentSchema = z.object({
  threadId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  authorId: z.string().trim().min(1),
  authorDisplayName: z.string().trim().min(1).nullable(),
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  editedAt: z.string().datetime({ offset: true }).nullable(),
  threadState: z.enum(['open', 'resolved']),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
  targetBlockId: z.string().trim().min(1).nullable(),
  selectedText: z.string().trim().min(1).nullable()
}).strict().superRefine(validateCommentResolution);

export const spaceSyncEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  syncId: z.string().trim().min(1),
  projectKey: z.string().trim().min(1),
  trigger: spaceSyncTriggerSchema,
  capturedAt: z.string().datetime({ offset: true }),
  page: spaceSyncPageSchema,
  comments: z.array(spaceSyncCommentSchema),
  coverage: spaceSyncCoverageSchema
}).strict();

export type SpaceSyncTrigger = z.infer<typeof spaceSyncTriggerSchema>;
export type SpaceSyncBlock = z.infer<typeof spaceSyncBlockSchema>;
export type SpaceSyncComment = z.infer<typeof spaceSyncCommentSchema>;
export type SpaceSyncCoverage = z.infer<typeof spaceSyncCoverageSchema>;
export type SpaceSyncPage = z.infer<typeof spaceSyncPageSchema>;
export type SpaceSyncEnvelopeV1 = z.infer<typeof spaceSyncEnvelopeV1Schema>;

export interface SpaceSyncEnvelopeLimits {
  maxBlocks: number;
  maxComments: number;
}

export type SpaceSyncLimitErrorCode = 'space_sync_too_many_blocks' | 'space_sync_too_many_comments';

export class SpaceSyncEnvelopeLimitExceededError extends Error {
  constructor(readonly code: SpaceSyncLimitErrorCode) {
    super(code);
  }
}

export function assertSpaceSyncEnvelopeWithinLimits(
  envelope: SpaceSyncEnvelopeV1,
  limits: SpaceSyncEnvelopeLimits
): void {
  if (envelope.page.blocks.length > limits.maxBlocks) {
    throw new SpaceSyncEnvelopeLimitExceededError('space_sync_too_many_blocks');
  }
  if (envelope.comments.length > limits.maxComments) {
    throw new SpaceSyncEnvelopeLimitExceededError('space_sync_too_many_comments');
  }
}

/** `blocks` is the sole body input; this is the one deterministic rendering every reader must agree on. */
export function canonicalSpacePageContentText(blocks: readonly SpaceSyncBlock[]): string {
  return blocks.map((block) => block.markdown).join('\n\n');
}

export function spacePageLogicalKey(pageId: string): string {
  return `chatgpt_space:page:${pageId}`;
}

export function spaceCommentLogicalKey(pageId: string, threadId: string, messageId: string): string {
  return `chatgpt_space:page:${pageId}:thread:${threadId}:message:${messageId}`;
}

export function spaceSyncCoverageLogicalKey(pageId: string, syncId: string): string {
  return `chatgpt_space:page:${pageId}:coverage:${syncId}`;
}

export function spaceSyncGapLogicalKey(pageId: string, syncId: string, gapCode: string): string {
  return `chatgpt_space:page:${pageId}:gap:${syncId}:${gapCode}`;
}
