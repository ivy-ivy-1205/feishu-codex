import type { FastifyInstance } from 'fastify';
import { spaceSyncEnvelopeV1Schema } from '../domain/space-sync.js';
import { SpaceSyncSignatureError, verifySpaceSyncSignature } from '../services/space-sync-signature.js';
import {
  ingestSpaceSyncEnvelope,
  SpaceSyncIngestionError,
  type SpaceSyncIngestionDependencies
} from '../services/space-sync-ingestion.js';

export interface SpaceSyncIngestRouteDependencies {
  secret: string;
  signatureWindowSeconds: number;
  maxBodyBytes: number;
  ingestion: Omit<SpaceSyncIngestionDependencies, 'now'> & { now?(): Date };
}

const ingestPath = '/internal/space-sync/v1/ingest';

export function registerSpaceSyncIngestRoutes(
  app: FastifyInstance,
  dependencies: SpaceSyncIngestRouteDependencies
): void {
  void app.register(async (instance) => {
    // Overrides the default JSON parser in this scope only: the HMAC signature
    // must be verified against the exact raw body bytes before they are parsed.
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    instance.post(ingestPath, { bodyLimit: dependencies.maxBodyBytes }, async (request, reply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ error: 'space_sync_invalid_body' });
      }
      if (rawBody.length > dependencies.maxBodyBytes) {
        return reply.code(413).send({ error: 'space_sync_body_too_large' });
      }

      const timestamp = firstHeaderValue(request.headers['x-space-sync-timestamp']);
      const syncIdHeader = firstHeaderValue(request.headers['x-space-sync-sync-id']);
      const signature = firstHeaderValue(request.headers['x-space-sync-signature']);
      if (!timestamp || !syncIdHeader || !signature) {
        return reply.code(400).send({ error: 'space_sync_missing_signature_headers' });
      }

      try {
        verifySpaceSyncSignature({
          timestamp,
          syncId: syncIdHeader,
          rawBody,
          secret: dependencies.secret,
          signature,
          nowMs: Date.now(),
          windowSeconds: dependencies.signatureWindowSeconds
        });
      } catch (error) {
        if (error instanceof SpaceSyncSignatureError) {
          return reply.code(401).send({ error: error.code });
        }
        throw error;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'space_sync_invalid_json' });
      }

      if (!isRecord(parsedBody) || parsedBody.syncId !== syncIdHeader) {
        return reply.code(400).send({ error: 'space_sync_sync_id_mismatch' });
      }

      const envelope = spaceSyncEnvelopeV1Schema.safeParse(parsedBody);
      if (!envelope.success) {
        request.log.warn({ reason: 'space_sync_invalid_envelope' }, 'Space sync envelope rejected');
        return reply.code(400).send({ error: 'space_sync_invalid_envelope' });
      }

      try {
        const result = ingestSpaceSyncEnvelope(envelope.data, {
          ...dependencies.ingestion,
          now: dependencies.ingestion.now ?? (() => new Date())
        });
        return reply.code(result.replay ? 200 : 201).send({
          status: 'accepted',
          syncId: result.syncId,
          replay: result.replay,
          unchanged: result.unchanged,
          run: {
            pageSourceCreated: !result.unchanged && result.run.pageSourceCreated,
            commentSourcesCreated: result.run.commentSourcesCreated,
            coveragePageComplete: result.run.coveragePageComplete,
            coverageCommentsComplete: result.run.coverageCommentsComplete,
            gapCount: result.run.gapCount
          }
        });
      } catch (error) {
        if (error instanceof SpaceSyncIngestionError) {
          const status = error.code === 'space_sync_envelope_conflict' ? 409 : 400;
          return reply.code(status).send({ error: error.code });
        }
        request.log.error({ err: error }, 'Space sync ingestion failed');
        return reply.code(500).send({ error: 'space_sync_ingestion_failed' });
      }
    });
  });
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
