import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OAuthStateError, type FeishuOAuthService } from '../services/feishu-oauth.js';

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

export interface FeishuOAuthRouteDependencies {
  oauth: FeishuOAuthService;
}

export function registerFeishuOAuthRoutes(
  app: FastifyInstance,
  dependencies: FeishuOAuthRouteDependencies
): void {
  app.get('/oauth/feishu/start', async () => ({
    authorizationUrl: dependencies.oauth.createAuthorizationUrl()
  }));

  app.get('/oauth/feishu/callback', async (request, reply) => {
    const query = callbackQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_oauth_callback' });
    }
    try {
      const result = await dependencies.oauth.completeCallback(query.data);
      return {
        status: 'authorized',
        openId: result.openId,
        subscriptionStatus: result.subscriptionStatus
      };
    } catch (error) {
      if (error instanceof OAuthStateError) {
        return reply.code(400).send({ error: 'invalid_oauth_state' });
      }
      request.log.error({ err: error }, 'Feishu OAuth callback failed');
      return reply.code(500).send({ error: 'oauth_callback_failed' });
    }
  });

  app.get('/diag/feishu/oauth', async () => dependencies.oauth.diagnostics());
}
