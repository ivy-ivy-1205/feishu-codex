import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { FeishuOAuthClient, FeishuOAuthTokenResponse } from '../services/feishu-oauth.js';

const tokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  access_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional()
}).passthrough();

const userInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({
    open_id: z.string().min(1)
  }).passthrough().optional()
}).passthrough();

export interface FeishuOAuthHttpClientOptions {
  appId: string;
  appSecret: string;
  sdkClient: FeishuOAuthSdkClientLike;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface FeishuOAuthSdkClientLike {
  minutes: {
    v1: {
      minute: {
        subscription(payload: {
          data: { event_type: string };
        }, options?: unknown): Promise<unknown>;
      };
    };
  };
}

export class FeishuOAuthHttpClient implements FeishuOAuthClient {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #sdkClient: FeishuOAuthSdkClientLike;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: FeishuOAuthHttpClientOptions) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#sdkClient = options.sdkClient;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? 'https://open.feishu.cn';
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<FeishuOAuthTokenResponse> {
    const token = await this.#requestToken({
      grant_type: 'authorization_code',
      client_id: this.#appId,
      client_secret: this.#appSecret,
      code: input.code,
      redirect_uri: input.redirectUri
    });
    const openId = await this.#getOpenId(token.userAccessToken);
    return { ...token, openId };
  }

  async refreshToken(refreshToken: string): Promise<FeishuOAuthTokenResponse> {
    const token = await this.#requestToken({
      grant_type: 'refresh_token',
      client_id: this.#appId,
      client_secret: this.#appSecret,
      refresh_token: refreshToken
    });
    const openId = await this.#getOpenId(token.userAccessToken);
    return { ...token, openId };
  }

  async subscribeMinuteGenerated(userAccessToken: string): Promise<void> {
    const response = await this.#sdkClient.minutes.v1.minute.subscription({
      data: { event_type: 'minutes.minute.generated_v1' }
    }, lark.withUserAccessToken(userAccessToken));
    assertFeishuSuccess(response);
  }

  async #requestToken(body: Record<string, string>): Promise<Omit<FeishuOAuthTokenResponse, 'openId'>> {
    const response = await this.#fetch(`${this.#baseUrl}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    const payload = tokenResponseSchema.parse(await response.json());
    if (
      payload.code !== 0 ||
      !payload.access_token ||
      !payload.refresh_token ||
      !payload.expires_in ||
      !payload.refresh_token_expires_in
    ) {
      throw new FeishuOAuthClientError(payload.msg ?? 'Feishu token request failed');
    }
    return {
      userAccessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresInSeconds: payload.expires_in,
      refreshExpiresInSeconds: payload.refresh_token_expires_in
    };
  }

  async #getOpenId(userAccessToken: string): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}/open-apis/authen/v1/user_info`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    const payload = userInfoResponseSchema.parse(await response.json());
    if (payload.code !== 0 || !payload.data?.open_id) {
      throw new FeishuOAuthClientError(payload.msg ?? 'Feishu user info request failed');
    }
    return payload.data.open_id;
  }
}

export class FeishuOAuthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuOAuthClientError';
  }
}

function assertFeishuSuccess(response: unknown): void {
  const parsed = z.object({
    code: z.number().optional(),
    msg: z.string().optional()
  }).passthrough().safeParse(response);
  if (!parsed.success) {
    throw new FeishuOAuthClientError('Feishu API response is invalid');
  }
  if (parsed.data.code !== undefined && parsed.data.code !== 0) {
    throw new FeishuOAuthClientError(parsed.data.msg ?? 'Feishu API request failed');
  }
}
