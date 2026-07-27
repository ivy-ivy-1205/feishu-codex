import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { OAuthTokenRepository } from '../src/repositories/oauth-token-repository.js';
import { FeishuOAuthService, InMemoryOAuthStateStore, type FeishuOAuthClient } from '../src/services/feishu-oauth.js';
import { TokenCrypto } from '../src/services/oauth-token-crypto.js';

describe('Feishu OAuth routes', () => {
  it('exchanges a verified OAuth callback, stores encrypted tokens, then records subscription success', async () => {
    const harness = createHarness();
    const start = await harness.app.inject({
      method: 'GET',
      url: '/oauth/feishu/start'
    });
    const authorizationUrl = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl);
    const state = authorizationUrl.searchParams.get('state');

    const callback = await harness.app.inject({
      method: 'GET',
      url: `/oauth/feishu/callback?code=auth_code_1&state=${state}`
    });

    const rawRow = harness.database.client.prepare(`
      SELECT open_id, user_access_token_ciphertext, refresh_token_ciphertext, subscription_status
      FROM feishu_user_oauth_tokens
      WHERE open_id = 'ou_ivy'
    `).get() as {
      open_id: string;
      user_access_token_ciphertext: string;
      refresh_token_ciphertext: string;
      subscription_status: string;
    };

    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({
      status: 'authorized',
      openId: 'ou_ivy',
      subscriptionStatus: 'subscribed'
    });
    expect(harness.calls).toEqual([
      { method: 'exchangeCode', code: 'auth_code_1', redirectUri: 'https://feishu-codex.aijia.ai/oauth/feishu/callback' },
      { method: 'subscribeMinuteGenerated', token: 'user-token-1' }
    ]);
    expect(rawRow).toMatchObject({
      open_id: 'ou_ivy',
      subscription_status: 'subscribed'
    });
    expect(rawRow.user_access_token_ciphertext).not.toContain('user-token-1');
    expect(rawRow.refresh_token_ciphertext).not.toContain('refresh-token-1');
    expect(harness.repository.findByOpenId('ou_ivy')).toMatchObject({
      openId: 'ou_ivy',
      userAccessToken: 'user-token-1',
      refreshToken: 'refresh-token-1',
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed'
    });
    await harness.close();
  });

  it('keeps the encrypted token and records subscription failure as a separate callback result', async () => {
    const harness = createHarness({ subscribeFails: true });
    const start = await harness.app.inject({
      method: 'GET',
      url: '/oauth/feishu/start'
    });
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl)
      .searchParams.get('state');

    const callback = await harness.app.inject({
      method: 'GET',
      url: `/oauth/feishu/callback?code=auth_code_1&state=${state}`
    });

    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({
      status: 'authorized',
      openId: 'ou_ivy',
      subscriptionStatus: 'failed'
    });
    expect(harness.calls).toEqual([
      { method: 'exchangeCode', code: 'auth_code_1', redirectUri: 'https://feishu-codex.aijia.ai/oauth/feishu/callback' },
      { method: 'subscribeMinuteGenerated', token: 'user-token-1' }
    ]);
    expect(harness.repository.findByOpenId('ou_ivy')).toMatchObject({
      openId: 'ou_ivy',
      userAccessToken: 'user-token-1',
      refreshToken: 'refresh-token-1',
      authorizationStatus: 'valid',
      subscriptionStatus: 'failed'
    });
    expect(harness.logs).toEqual([{
      level: 'warn',
      message: 'Feishu minute event subscription failed after OAuth token storage'
    }]);
    await harness.close();
  });

  it('rejects callback replay with the same state', async () => {
    const harness = createHarness();
    const start = await harness.app.inject({ method: 'GET', url: '/oauth/feishu/start' });
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl)
      .searchParams.get('state');

    const first = await harness.app.inject({
      method: 'GET',
      url: `/oauth/feishu/callback?code=auth_code_1&state=${state}`
    });
    const replay = await harness.app.inject({
      method: 'GET',
      url: `/oauth/feishu/callback?code=auth_code_2&state=${state}`
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'invalid_oauth_state' });
    await harness.close();
  });
});

function createHarness(options: { subscribeFails?: boolean } = {}) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const repository = new OAuthTokenRepository(
    database.client,
    new TokenCrypto(randomBytes(32))
  );
  const calls: unknown[] = [];
  const client: FeishuOAuthClient = {
    async exchangeCode(input) {
      calls.push({ method: 'exchangeCode', code: input.code, redirectUri: input.redirectUri });
      return {
        openId: 'ou_ivy',
        userAccessToken: 'user-token-1',
        refreshToken: 'refresh-token-1',
        expiresInSeconds: 7_200,
        refreshExpiresInSeconds: 2_592_000
      };
    },
    async refreshToken() {
      throw new Error('not used in this test');
    },
    async subscribeMinuteGenerated(userAccessToken) {
      calls.push({ method: 'subscribeMinuteGenerated', token: userAccessToken });
      if (options.subscribeFails) {
        throw new Error('subscription permission missing');
      }
    }
  };
  const logs: Array<{ level: string; message: string }> = [];
  const oauth = new FeishuOAuthService({
    appId: 'cli_test',
    redirectUri: 'https://feishu-codex.aijia.ai/oauth/feishu/callback',
    scopes: [
      'auth:user.id:read',
      'offline_access',
      'minutes:minutes.basic:read',
      'minutes:minutes.transcript:export'
    ],
    stateStore: new InMemoryOAuthStateStore(),
    tokenRepository: repository,
    client,
    logger: {
      warn: (_context, message) => logs.push({ level: 'warn', message })
    },
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
    calls,
    logs,
    database,
    repository,
    async close() {
      await app.close();
      database.close();
    }
  };
}
