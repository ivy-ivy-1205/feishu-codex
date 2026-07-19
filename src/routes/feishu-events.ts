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
    parent_id: z.string().min(1).nullable().optional(),
    root_id: z.string().min(1).nullable().optional(),
    message_type: z.literal('text'),
    content: z.string().min(1)
  })
});

const textContentSchema = z.object({ text: z.string().trim().min(1) });
const replyEventType = 'im.message.receive_v1';

export interface FeishuEventRouteDependencies {
  verificationToken: string;
  encryptKey: string;
  ingestMinute(event: unknown): IngestionResult;
  routeReply(input: unknown): ReplyDecision;
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
      return reply.code(400).send({ error: 'invalid_event_envelope' });
    }
    if (envelope.data.header.token !== dependencies.verificationToken) {
      return reply.code(401).send({ error: 'invalid_verification_token' });
    }

    if (envelope.data.header.event_type === replyEventType) {
      const replyInput = parseReplyInput(envelope.data.event);
      if (replyInput === null) {
        return reply.code(400).send({ error: 'invalid_reply_event' });
      }
      try {
        return {
          status: 'reply_decision',
          decision: dependencies.routeReply(replyInput)
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
        return reply.code(400).send({ error: 'invalid_event_envelope' });
      }
      request.log.error({ err: error }, 'Feishu event ingestion failed');
      return reply.code(500).send({ error: 'event_ingestion_failed' });
    }
  });
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
    const content = textContentSchema.safeParse(JSON.parse(parsedEvent.data.message.content));
    if (!content.success) {
      return null;
    }
    return {
      chatId: parsedEvent.data.message.chat_id,
      openId: parsedEvent.data.sender.sender_id.open_id,
      replyTo: parsedEvent.data.message.parent_id ?? parsedEvent.data.message.root_id ?? null,
      text: content.data.text
    };
  } catch {
    return null;
  }
}
