import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { OAuthTokenRepository } from '../src/repositories/oauth-token-repository.js';
import { FeishuOAuthService, InMemoryOAuthStateStore, type FeishuOAuthClient } from '../src/services/feishu-oauth.js';
import { TokenCrypto } from '../src/services/oauth-token-crypto.js';

describe('Feishu OAuth diagnostics and revocation', () => {
  it('reports token validity, subscription status, last event time, and stale state without exposing tokens', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'secret-user-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T09:00:00.000Z')
    });
    harness.repository.markEventReceived('ou_ivy', new Date('2026-07-26T09:59:00.000Z'));

    const response = await harness.app.inject({
      method: 'GET',
      url: '/diag/feishu/oauth'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      users: [{
        openId: 'ou_ivy',
        authorized: true,
        expired: false,
        subscribed: true,
        accessTokenExpiresAt: '2026-07-27T12:00:00.000Z',
        refreshTokenExpiresAt: '2026-08-26T10:00:00.000Z',
        lastEventAt: '2026-07-26T09:59:00.000Z',
        stale: true,
        authorizationStatus: 'valid',
        subscriptionStatus: 'subscribed',
        updatedAt: '2026-07-26T09:59:00.000Z'
      }]
    });
    expect(response.body).not.toContain('secret-user-token');
    expect(response.body).not.toContain('secret-refresh-token');
    await harness.close();
  });

  it('distinguishes subscription failure from a subscribed user that has not received events yet', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'secret-user-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'failed',
      now: new Date('2026-07-27T09:00:00.000Z')
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/diag/feishu/oauth'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ users: Array<{ subscribed: boolean; lastEventAt: string | null; stale: boolean; subscriptionStatus: string }> }>()
      .users[0]).toMatchObject({
        subscribed: false,
        lastEventAt: null,
        stale: true,
        subscriptionStatus: 'failed'
      });
    await harness.close();
  });

  it('marks Ivy authorization invalid and sends reauthorization when Feishu reports token revocation', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'secret-user-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T09:00:00.000Z')
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: {
        schema: '2.0',
        header: {
          token: 'verify',
          event_id: 'evt_revoked_1',
          event_type: 'auth.user_access_token.revoked_v4',
          create_time: '1785146400000'
        },
        event: {
          open_id: 'ou_ivy'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'oauth_revocation_recorded' });
    expect(harness.repository.findByOpenId('ou_ivy')).toMatchObject({
      authorizationStatus: 'invalid'
    });
    expect(harness.messages).toHaveLength(1);
    expect(JSON.stringify(harness.messages[0]?.card)).toContain('授权已过期');
    expect(harness.messages[0]?.fallbackText).toContain('https://passport.feishu.cn/');
    await harness.close();
  });

  it('updates last event time when a subscribed minute event arrives', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'secret-user-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T09:00:00.000Z')
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhooks/feishu/events',
      payload: {
        schema: '2.0',
        header: {
          token: 'verify',
          event_id: 'evt_minute_auto_1',
          event_type: 'minutes.minute.generated_v1',
          create_time: '1785146400000'
        },
        event: {
          minute_token: 'obcn_auto',
          subscriber_ids: [{ open_id: 'ou_ivy' }]
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(harness.repository.findByOpenId('ou_ivy')).toMatchObject({
      lastEventAt: '2026-07-27T10:00:00.000Z'
    });
    await harness.close();
  });
});

function createHarness() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const repository = new OAuthTokenRepository(
    database.client,
    new TokenCrypto(randomBytes(32))
  );
  const cards: Array<{ chatId: string; card: Record<string, unknown>; fallbackText: string }> = [];
  const client: FeishuOAuthClient = {
    async exchangeCode() {
      throw new Error('not used in this test');
    },
    async refreshToken() {
      throw new Error('not used in this test');
    },
    async subscribeMinuteGenerated() {
      throw new Error('not used in this test');
    }
  };
  const oauth = new FeishuOAuthService({
    appId: 'cli_test',
    redirectUri: 'https://feishu-codex.aijia.ai/oauth/feishu/callback',
    scopes: [],
    stateStore: new InMemoryOAuthStateStore(),
    tokenRepository: repository,
    client,
    ivyPrivateChatId: 'oc_ivy_private',
    sendReauthorizationCard: async (message) => {
      cards.push(message);
      return { messageId: 'om_reauth' };
    },
    staleEventMs: 24 * 60 * 60 * 1_000,
    now: () => new Date('2026-07-27T10:00:00.000Z')
  });
  const app = buildApp({
    readiness: () => ({ ready: true }),
    verificationToken: 'verify',
    encryptKey: 'encrypt',
    ingestMinute: () => ({ status: 'accepted' }),
    routeReply: () => ({ kind: 'clarify', reason: 'missing_reply_context' }),
    oauth,
    logger: false
  });
  return {
    app,
    repository,
    messages: cards,
    async close() {
      await app.close();
      database.close();
    }
  };
}
