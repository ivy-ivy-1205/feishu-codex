import { describe, expect, it } from 'vitest';
import { FeishuOAuthHttpClient, type FeishuOAuthSdkClientLike } from '../src/adapters/feishu-oauth-client.js';

describe('FeishuOAuthHttpClient', () => {
  it('exchanges OAuth code through v2 token API, reads open_id, and subscribes minute events with user token', async () => {
    const calls: unknown[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: 'fetch', url: String(url), init });
      if (String(url).endsWith('/open-apis/authen/v2/oauth/token')) {
        return jsonResponse({
          code: 0,
          access_token: 'user-token',
          refresh_token: 'refresh-token',
          expires_in: 7_200,
          refresh_token_expires_in: 2_592_000
        });
      }
      if (String(url).endsWith('/open-apis/authen/v1/user_info')) {
        return jsonResponse({
          code: 0,
          data: { open_id: 'ou_ivy' }
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    };
    const sdkClient: FeishuOAuthSdkClientLike = {
      minutes: {
        v1: {
          minute: {
            async subscription(payload, options) {
              calls.push({ method: 'subscription', payload, hasOptions: Boolean(options) });
              return { code: 0, msg: 'success' };
            }
          }
        }
      }
    };
    const client = new FeishuOAuthHttpClient({
      appId: 'cli_test',
      appSecret: 'app-secret',
      sdkClient,
      fetchImpl,
      baseUrl: 'https://open.feishu.cn'
    });

    await expect(client.exchangeCode({
      code: 'oauth-code',
      redirectUri: 'https://feishu-codex.aijia.ai/oauth/feishu/callback'
    })).resolves.toEqual({
      openId: 'ou_ivy',
      userAccessToken: 'user-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 7_200,
      refreshExpiresInSeconds: 2_592_000
    });
    await client.subscribeMinuteGenerated('user-token');

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      method: 'fetch',
      url: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
    });
    expect(JSON.parse((calls[0] as { init: RequestInit }).init.body as string)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cli_test',
      client_secret: 'app-secret',
      code: 'oauth-code',
      redirect_uri: 'https://feishu-codex.aijia.ai/oauth/feishu/callback'
    });
    expect(calls[1]).toMatchObject({
      method: 'fetch',
      url: 'https://open.feishu.cn/open-apis/authen/v1/user_info'
    });
    expect(calls[2]).toMatchObject({
      method: 'subscription',
      payload: { data: { event_type: 'minutes.minute.generated_v1' } },
      hasOptions: true
    });
  });
});

function jsonResponse(payload: unknown): Response {
  return {
    async json() {
      return payload;
    }
  } as Response;
}
