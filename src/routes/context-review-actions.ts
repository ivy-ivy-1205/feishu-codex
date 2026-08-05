import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContextCandidateRepository } from '../repositories/context-candidate-repository.js';
import {
  ContextRecordRepository, ContextReviewConflictError,
  type PromoteCandidateInput
} from '../repositories/context-record-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { decryptFeishuBody } from './feishu-events.js';

const actionValueBase = {
  candidateId: z.string().trim().regex(/^ctxcand_[a-f0-9]{32}$/),
  expectedReviewStatus: z.enum(['pending', 'needs_clarification', 'conflict']),
  cardNonce: z.string().trim().min(1).max(256)
};
const actionValueSchema = z.discriminatedUnion('action', [
  z.object({ ...actionValueBase, action: z.literal('approve_keep_status') }).strict(),
  z.object({ ...actionValueBase, action: z.literal('approve_verified') }).strict(),
  z.object({ ...actionValueBase, action: z.literal('reject') }).strict(),
  z.object({ ...actionValueBase, action: z.literal('request_clarification') }).strict(),
  z.object({ ...actionValueBase, action: z.literal('mark_conflict') }).strict(),
  z.object({ ...actionValueBase, action: z.literal('apply_suggested_relation'),
    promotionIntentId: z.string().regex(/^ctxpi_[a-f0-9]{32}$/) }).strict()
]);
const callbackSchema = z.object({
  schema: z.literal('2.0'),
  header: z.object({ token: z.string().min(1), event_id: z.string().min(1) }).passthrough(),
  event: z.object({
    operator: z.object({ operator_id: z.object({ open_id: z.string().min(1) }).passthrough() }).passthrough(),
    context: z.object({ open_chat_id: z.string().min(1), open_message_id: z.string().min(1) }).passthrough(),
    action: z.object({ value: actionValueSchema }).passthrough()
  }).passthrough()
});

export interface ContextReviewActionRouteDependencies {
  verificationToken: string;
  encryptKey: string;
  ivyPrivateChatId: string;
  approverOpenIds: readonly string[];
  outboxRepository: OutboxRepository;
  recordRepository: ContextRecordRepository;
  now?: () => Date;
}

export function registerContextReviewActionRoutes(
  app: FastifyInstance,
  dependencies: ContextReviewActionRouteDependencies
): void {
  app.post('/webhooks/feishu/card-actions', async (request, reply) => {
    const decrypted = decryptFeishuBody(request.body, dependencies.encryptKey);
    if (decrypted === null) return reply.code(400).send({ error: 'invalid_encrypted_payload' });
    const callback = callbackSchema.safeParse(decrypted);
    if (!callback.success) return reply.code(400).send({ error: 'invalid_context_review_callback' });
    if (callback.data.header.token !== dependencies.verificationToken) {
      return reply.code(401).send({ error: 'invalid_verification_token' });
    }
    const { event, header } = callback.data;
    const reviewerOpenId = event.operator.operator_id.open_id;
    if (!dependencies.approverOpenIds.includes(reviewerOpenId)) {
      return reply.code(403).send({ error: 'context_reviewer_unauthorized' });
    }
    if (event.context.open_chat_id !== dependencies.ivyPrivateChatId) {
      return reply.code(403).send({ error: 'context_review_wrong_chat' });
    }
    const delivery = dependencies.outboxRepository.findDeliveredContextReview(event.context.open_message_id);
    if (!delivery || delivery.targetChatId !== event.context.open_chat_id) {
      return reply.code(409).send({ error: 'context_review_delivery_not_found' });
    }
    const value = event.action.value;
    if (delivery.cardNonce !== value.cardNonce) {
      return reply.code(409).send({ error: 'context_review_nonce_mismatch' });
    }
    const now = dependencies.now?.() ?? new Date();
    if (!Number.isFinite(Date.parse(delivery.expiresAt)) || now.getTime() > Date.parse(delivery.expiresAt)) {
      return reply.code(409).send({ error: 'context_review_card_expired' });
    }
    const candidateRepository = new ContextCandidateRepository(dependencies.recordRepository.client);
    const candidate = candidateRepository.getCandidate(value.candidateId);
    if (!candidate) return reply.code(404).send({ error: 'context_candidate_not_found' });
    if (candidate.extractionRunId !== delivery.extractionRunId || !delivery.candidateIds.includes(candidate.id)) {
      return reply.code(409).send({ error: 'context_candidate_card_mismatch' });
    }
    if ((value.action === 'approve_keep_status' || value.action === 'approve_verified') && candidate.reviewStatus === 'conflict') {
      return reply.code(409).send({ error: 'conflict_candidate_cannot_be_approved' });
    }
    const promotionIntent = value.action === 'apply_suggested_relation'
      ? delivery.promotionIntents.find((intent) =>
        intent.id === value.promotionIntentId && intent.candidateId === candidate.id) ?? null
      : null;
    if (value.action === 'apply_suggested_relation' && !promotionIntent) {
      return reply.code(409).send({ error: 'context_promotion_intent_invalid' });
    }
    try {
      const result = dependencies.recordRepository.promoteCandidate({
        candidateId: candidate.id,
        expectedReviewStatus: value.expectedReviewStatus,
        reviewerOpenId,
        action: promotionIntent?.relationType === 'conflicts_with' ? 'mark_conflict' : mapAction(value.action),
        ...(value.action === 'approve_verified' ? { decidedFactualStatus: 'evidence_verified' as const } : {}),
        ...(promotionIntent ? { targetRecordId: promotionIntent.targetRecordId,
          relationType: promotionIntent.relationType } : {}),
        idempotencyKey: `feishu-card:${header.event_id}:${candidate.id}:${value.action}`,
        reviewedAt: now
      });
      return {
        status: result.outcome,
        candidateId: result.candidateId,
        reviewStatus: result.reviewStatus,
        factualStatus: result.factualStatus,
        recordId: result.recordId,
        versionNumber: result.versionNumber
      };
    } catch (error) {
      if (error instanceof ContextReviewConflictError) {
        return reply.code(409).send({ error: 'context_candidate_already_handled' });
      }
      request.log.error({ err: error }, 'Context review callback failed');
      return reply.code(400).send({ error: 'context_review_invalid' });
    }
  });
}

function mapAction(action: z.infer<typeof actionValueSchema>['action']): PromoteCandidateInput['action'] {
  if (action === 'apply_suggested_relation') return 'approve';
  if (action === 'approve_keep_status' || action === 'approve_verified') return 'approve';
  if (action === 'request_clarification') return 'request_clarification';
  if (action === 'mark_conflict') return 'mark_conflict';
  return 'reject';
}
