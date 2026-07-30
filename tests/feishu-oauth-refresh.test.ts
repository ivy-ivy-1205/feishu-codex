import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { OAuthTokenRepository } from '../src/repositories/oauth-token-repository.js';
import { FeishuOAuthService, InMemoryOAuthStateStore, type FeishuOAuthClient } from '../src/services/feishu-oauth.js';
import { TokenCrypto } from '../src/services/oauth-token-crypto.js';

describe('Feishu OAuth token refresh', () => {
  it('refreshes a near-expiry user token and keeps authorization valid', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'old-user-token',
      refreshToken: 'old-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T10:04:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T10:00:00.000Z')
    });

    const result = await harness.service.ensureFreshToken('ou_ivy');

    expect(result).toEqual({ status: 'refreshed' });
    expect(harness.calls).toEqual([{ method: 'refreshToken', refreshToken: 'old-refresh-token' }]);
    expect(harness.repository.findByOpenId('ou_ivy')).toMatchObject({
      userAccessToken: 'new-user-token',
      refreshToken: 'new-refresh-token',
      authorizationStatus: 'valid'
    });
    await harness.close();
  });

  it('resolves a fresh user access token for the subscribed minute event user', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'old-user-token',
      refreshToken: 'old-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T10:04:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T10:00:00.000Z')
    });

    await expect(harness.service.resolveUserAccessToken({
      candidateOpenIds: ['ou_ivy']
    })).resolves.toEqual({
      status: 'available',
      openId: 'ou_ivy',
      userAccessToken: 'new-user-token'
    });
    expect(harness.calls).toEqual([{ method: 'refreshToken', refreshToken: 'old-refresh-token' }]);
    await harness.close();
  });

  it('uses the only authorized user token when a legacy minute job has no subscriber IDs', async () => {
    const harness = createHarness();
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'fresh-user-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-08-26T10:00:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T10:00:00.000Z')
    });

    await expect(harness.service.resolveUserAccessToken({
      candidateOpenIds: []
    })).resolves.toEqual({
      status: 'available',
      openId: 'ou_ivy',
      userAccessToken: 'fresh-user-token'
    });
    expect(harness.calls).toEqual([]);
    await harness.close();
  });

  it('marks authorization invalid and sends a reauthorization card when refresh fails', async () => {
    const harness = createHarness({ refreshFails: true });
    harness.repository.saveToken({
      openId: 'ou_ivy',
      userAccessToken: 'old-user-token',
      refreshToken: 'expired-refresh-token',
      accessTokenExpiresAt: new Date('2026-07-27T10:04:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-07-27T10:05:00.000Z'),
      authorizationStatus: 'valid',
      subscriptionStatus: 'subscribed',
      now: new Date('2026-07-27T10:00:00.000Z')
    });

    const result = await harness.service.ensureFreshToken('ou_ivy');

    expect(result).toEqual({ status: 'reauthorization_required' });
    expect(harness.repository.findByOpenId('ou_ivy')).toMatchObject({
      authorizationStatus: 'invalid'
    });
    expect(harness.cards).toHaveLength(1);
    expect(harness.cards[0]).toMatchObject({ chatId: 'oc_ivy_private' });
    expect(JSON.stringify(harness.cards[0]?.card)).toContain('授权已过期');
    expect(harness.cards[0]?.fallbackText).toContain('https://passport.feishu.cn/');
    await harness.close();
  });
});

function createHarness(options: { refreshFails?: boolean } = {}) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  const repository = new OAuthTokenRepository(
    database.client,
    new TokenCrypto(randomBytes(32))
  );
  const calls: unknown[] = [];
  const cards: Array<{ chatId: string; card: Record<string, unknown>; fallbackText: string }> = [];
  const client: FeishuOAuthClient = {
    async exchangeCode() {
      throw new Error('not used in this test');
    },
    async refreshToken(refreshToken) {
      calls.push({ method: 'refreshToken', refreshToken });
      if (options.refreshFails) {
        throw new Error('refresh token expired');
      }
      return {
        openId: 'ou_ivy',
        userAccessToken: 'new-user-token',
        refreshToken: 'new-refresh-token',
        expiresInSeconds: 7_200,
        refreshExpiresInSeconds: 2_592_000
      };
    },
    async subscribeMinuteGenerated() {
      throw new Error('not used in this test');
    }
  };
  const service = new FeishuOAuthService({
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
    now: () => new Date('2026-07-27T10:00:00.000Z')
  });
  return {
    database,
    repository,
    service,
    calls,
    cards,
    async close() {
      database.close();
    }
  };
}
