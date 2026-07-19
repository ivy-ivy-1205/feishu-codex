import { createDecipheriv, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { ReplyDecision } from '../domain/authorization.js';
import type { IngestionResult } from '../services/minute-ingestion.js';

const verificationRequestSchema = z.object({
  type: z.literal('url_verification'),
  token: z.string().min(1),
  challenge: z.string().min(1)
});

const encryptedPayloadSchema = z.object({
  encrypt: z.string().min(1)
});

const eventEnvelopeSchema = z.object({
  schema: z.literal('2.0'),
  header: z.object({
    token: z.string().min(1),
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    create_time: z.string().min(1)
  }),
  event: z.record(z.string(), z.unknown())
});

const replyEventSchema = z.object({
  sender: z.object({
    sender_id: z.object({
      open_id: z.string().min(1)
    })
  }),
  message: z.object({
    chat_id: z.string().min(1),
    parent_id: z.string().nullable().optional(),
    root_id: z.string().nullable().optional(),
    message_type: z.enum(['text', 'post']),
    content: z.string().min(1)
  })
});

const textContentSchema = z.object({ text: z.string().trim().min(1) });
const postTextLeafSchema = z.object({
  tag: z.literal('text'),
  text: z.string()
}).passthrough();
const postContentSchema = z.object({
  content: z.array(z.array(z.unknown()))
}).passthrough();
const replyEventType = 'im.message.receive_v1';

export interface FeishuEventRouteDependencies {
  verificationToken: string;
  encryptKey: string;
  ingestMinute(event: unknown): IngestionResult;
  routeReply(input: unknown): ReplyDecision;
  sendTextMessage?(input: { chatId: string; text: string }): Promise<{ messageId: string }>;
}

export function registerFeishuEventRoutes(
  app: FastifyInstance,
  dependencies: FeishuEventRouteDependencies
): void {
  app.post('/webhooks/feishu/events', async (request, reply) => {
    const body = decryptFeishuBody(request.body, dependencies.encryptKey);
    if (body === null) {
      return reply.code(400).send({ error: 'invalid_encrypted_payload' });
    }

    const verification = verificationRequestSchema.safeParse(body);
    if (verification.success) {
      if (verification.data.token !== dependencies.verificationToken) {
        return reply.code(401).send({ error: 'invalid_verification_token' });
      }
      return { challenge: verification.data.challenge };
    }

    const envelope = eventEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      logRejectedFeishuEvent(request.log, 'invalid_event_envelope', body);
      return reply.code(400).send({ error: 'invalid_event_envelope' });
    }
    if (envelope.data.header.token !== dependencies.verificationToken) {
      return reply.code(401).send({ error: 'invalid_verification_token' });
    }

    if (envelope.data.header.event_type === replyEventType) {
      const replyInput = parseReplyInput(envelope.data.event);
      if (replyInput === null) {
        logRejectedFeishuEvent(request.log, 'invalid_reply_event', body);
        return reply.code(400).send({ error: 'invalid_reply_event' });
      }
      try {
        const decision = dependencies.routeReply(replyInput);
        request.log.info({
          feishuReplyDiagnostics: {
            hasOpenId: replyInput.openId.length > 0,
            hasChatId: replyInput.chatId.length > 0,
            hasReplyTo: replyInput.replyTo !== null,
            messageTextLength: replyInput.text.length,
            decisionKind: decision.kind
          }
        }, 'Feishu reply event parsed');
        const acknowledgement = await maybeAcknowledgeDirectMessage({
          decision,
          replyInput,
          sendTextMessage: dependencies.sendTextMessage,
          log: request.log
        });
        return {
          status: 'reply_decision',
          decision,
          ...(acknowledgement ? { acknowledgement } : {})
        };
      } catch (error) {
        request.log.error({ err: error }, 'Feishu reply routing failed');
        return reply.code(500).send({ error: 'reply_routing_failed' });
      }
    }

    try {
      return dependencies.ingestMinute(body);
    } catch (error) {
      if (error instanceof ZodError) {
        logRejectedFeishuEvent(request.log, 'invalid_event_envelope', body);
        return reply.code(400).send({ error: 'invalid_event_envelope' });
      }
      request.log.error({ err: error }, 'Feishu event ingestion failed');
      return reply.code(500).send({ error: 'event_ingestion_failed' });
    }
  });
}

const directMessageAcknowledgementText =
  '我已收到。当前还未绑定会议纪要，请在会议总结下回复 Todo 编号，或等待妙记事件接入。';
type DirectAcknowledgementResult =
  | { status: 'delivered'; messageId: string }
  | { status: 'failed'; errorStatus: number | null; errorCode: number | null };

async function maybeAcknowledgeDirectMessage(input: {
  decision: ReplyDecision;
  replyInput: {
    chatId: string;
    openId: string;
    replyTo: string | null;
    text: string;
  };
  sendTextMessage?: (message: { chatId: string; text: string }) => Promise<{ messageId: string }>;
  log: FastifyInstance['log'];
}): Promise<DirectAcknowledgementResult | null> {
  if (
    !input.sendTextMessage
  ) {
    return null;
  }
  const text = directAcknowledgementTextFor(input.decision, {
    openId: input.replyInput.openId,
    chatId: input.replyInput.chatId
  });
  if (text === null) {
    return null;
  }
  try {
    const acknowledgement = await input.sendTextMessage({
      chatId: input.replyInput.chatId,
      text
    });
    input.log.info({
      feishuAcknowledgementDiagnostics: {
        status: 'delivered',
        hasMessageId: acknowledgement.messageId.length > 0,
        decisionKind: input.decision.kind
      }
    }, 'Feishu direct acknowledgement delivered');
    return { status: 'delivered', messageId: acknowledgement.messageId };
  } catch (error) {
    const failure = describeFeishuSendFailure(error);
    input.log.warn({
      feishuAcknowledgementDiagnostics: {
        status: 'failed',
        decisionKind: input.decision.kind,
        ...failure
      }
    }, 'Feishu direct acknowledgement failed');
    return {
      status: 'failed',
      errorStatus: failure.errorStatus,
      errorCode: failure.errorCode
    };
  }
}

function directAcknowledgementTextFor(
  decision: ReplyDecision,
  identity: { openId: string; chatId: string }
): string | null {
  if (decision.kind === 'identify_ivy') {
    return `检测到待绑定 Ivy 身份，你的 open_id 是：${identity.openId}；当前私聊 chat_id 是：${identity.chatId}。请回 Codex 确认绑定。`;
  }
  if (decision.kind === 'clarify' && decision.reason === 'missing_reply_context') {
    return directMessageAcknowledgementText;
  }
  return null;
}

function decryptFeishuBody(body: unknown, encryptKey: string): unknown | null {
  const encrypted = encryptedPayloadSchema.safeParse(body);
  if (!encrypted.success) {
    return body;
  }

  try {
    const encryptedBytes = Buffer.from(encrypted.data.encrypt, 'base64');
    if (encryptedBytes.length <= 16) {
      return null;
    }
    const iv = encryptedBytes.subarray(0, 16);
    const ciphertext = encryptedBytes.subarray(16);
    const key = createHash('sha256').update(encryptKey, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(decrypted) as unknown;
  } catch {
    return null;
  }
}

function parseReplyInput(event: unknown): {
  chatId: string;
  openId: string;
  replyTo: string | null;
  text: string;
} | null {
  const parsedEvent = replyEventSchema.safeParse(event);
  if (!parsedEvent.success) {
    return null;
  }

  try {
    const text = extractMessageText(
      parsedEvent.data.message.message_type,
      parsedEvent.data.message.content
    );
    if (text === null) {
      return null;
    }
    return {
      chatId: parsedEvent.data.message.chat_id,
      openId: parsedEvent.data.sender.sender_id.open_id,
      replyTo: normalizeReplyContext(
        parsedEvent.data.message.parent_id,
        parsedEvent.data.message.root_id
      ),
      text
    };
  } catch {
    return null;
  }
}

function extractMessageText(messageType: 'text' | 'post', rawContent: string): string | null {
  const parsedContent = JSON.parse(rawContent) as unknown;
  if (messageType === 'text') {
    const content = textContentSchema.safeParse(parsedContent);
    return content.success ? content.data.text : null;
  }

  const content = postContentSchema.safeParse(parsedContent);
  if (!content.success) {
    return null;
  }
  const text = content.data.content
    .flatMap((line) => line)
    .map((leaf) => postTextLeafSchema.safeParse(leaf))
    .filter((leaf): leaf is { success: true; data: { tag: 'text'; text: string } } => leaf.success)
    .map((leaf) => leaf.data.text)
    .join('')
    .trim();
  return text.length > 0 ? text : null;
}

function normalizeReplyContext(
  parentId: string | null | undefined,
  rootId: string | null | undefined
): string | null {
  const normalizedParentId = normalizeOptionalId(parentId);
  if (normalizedParentId !== null) {
    return normalizedParentId;
  }
  return normalizeOptionalId(rootId);
}

function normalizeOptionalId(id: string | null | undefined): string | null {
  if (typeof id !== 'string') {
    return null;
  }
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function logRejectedFeishuEvent(
  log: FastifyInstance['log'],
  reason: string,
  body: unknown
): void {
  log.warn({
    reason,
    feishuEventShape: describeFeishuEventShape(body)
  }, 'Feishu event rejected');
}

function describeFeishuSendFailure(error: unknown): {
  errorStatus: number | null;
  errorCode: number | null;
  errorMessage: string | null;
} {
  if (!isRecord(error)) {
    return { errorStatus: null, errorCode: null, errorMessage: null };
  }
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  return {
    errorStatus: typeof response?.status === 'number' ? response.status : null,
    errorCode: typeof data?.code === 'number' ? data.code : null,
    errorMessage: typeof data?.msg === 'string' ? data.msg.slice(0, 240) : null
  };
}

function describeFeishuEventShape(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    return { bodyType: typeof body };
  }
  const header = isRecord(body.header) ? body.header : null;
  const event = isRecord(body.event) ? body.event : null;
  const message = event && isRecord(event.message) ? event.message : null;
  const sender = event && isRecord(event.sender) ? event.sender : null;
  return {
    bodyKeys: Object.keys(body).sort(),
    schema: typeof body.schema === 'string' ? body.schema : typeof body.schema,
    headerKeys: header ? Object.keys(header).sort() : [],
    eventType: header && typeof header.event_type === 'string' ? header.event_type : null,
    eventKeys: event ? Object.keys(event).sort() : [],
    messageKeys: message ? Object.keys(message).sort() : [],
    messageType: message && typeof message.message_type === 'string'
      ? message.message_type
      : null,
    senderKeys: sender ? Object.keys(sender).sort() : []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
