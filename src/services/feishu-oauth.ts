import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { OAuthTokenRepository, OAuthSubscriptionStatus } from '../repositories/oauth-token-repository.js';

export interface FeishuOAuthClient {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<FeishuOAuthTokenResponse>;
  refreshToken(refreshToken: string): Promise<FeishuOAuthTokenResponse>;
  subscribeMinuteGenerated(userAccessToken: string): Promise<void>;
}

export interface FeishuOAuthTokenResponse {
  openId: string;
  userAccessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshExpiresInSeconds: number;
}

export interface OAuthStateStore {
  issue(input: { now: Date; ttlMs: number }): string;
  consume(input: { state: string; now: Date }): boolean;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  readonly #states = new Map<string, number>();

  issue(input: { now: Date; ttlMs: number }): string {
    const state = randomBytes(24).toString('base64url');
    this.#states.set(state, input.now.getTime() + input.ttlMs);
    return state;
  }

  consume(input: { state: string; now: Date }): boolean {
    const expiresAt = this.#states.get(input.state);
    this.#states.delete(input.state);
    if (!expiresAt || expiresAt < input.now.getTime()) {
      return false;
    }
    return safeEqual(input.state, input.state);
  }
}

export interface FeishuOAuthServiceOptions {
  appId: string;
  redirectUri: string;
  authBaseUrl?: string;
  scopes: string[];
  stateStore: OAuthStateStore;
  tokenRepository: OAuthTokenRepository;
  client: FeishuOAuthClient;
  ivyPrivateChatId?: string;
  sendReauthorizationCard?: (input: {
    chatId: string;
    card: Record<string, unknown>;
    fallbackText: string;
  }) => Promise<{ messageId: string }>;
  sendReauthorizationMessage?: (input: { chatId: string; text: string }) => Promise<{ messageId: string }>;
  logger?: {
    warn(context: Record<string, unknown>, message: string): void;
  };
  stateTtlMs?: number;
  refreshSkewMs?: number;
  staleEventMs?: number;
  now?: () => Date;
}

export class FeishuOAuthService {
  readonly #appId: string;
  readonly #redirectUri: string;
  readonly #authBaseUrl: string;
  readonly #scopes: string[];
  readonly #stateStore: OAuthStateStore;
  readonly #tokenRepository: OAuthTokenRepository;
  readonly #client: FeishuOAuthClient;
  readonly #ivyPrivateChatId: string | null;
  readonly #sendReauthorizationCard: ((input: {
    chatId: string;
    card: Record<string, unknown>;
    fallbackText: string;
  }) => Promise<{ messageId: string }>) | null;
  readonly #sendReauthorizationMessage: ((input: { chatId: string; text: string }) => Promise<{ messageId: string }>) | null;
  readonly #logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
  readonly #stateTtlMs: number;
  readonly #refreshSkewMs: number;
  readonly #staleEventMs: number;
  readonly #now: () => Date;

  constructor(options: FeishuOAuthServiceOptions) {
    this.#appId = options.appId;
    this.#redirectUri = options.redirectUri;
    this.#authBaseUrl = options.authBaseUrl ?? 'https://passport.feishu.cn/suite/passport/oauth/authorize';
    this.#scopes = options.scopes;
    this.#stateStore = options.stateStore;
    this.#tokenRepository = options.tokenRepository;
    this.#client = options.client;
    this.#ivyPrivateChatId = options.ivyPrivateChatId ?? null;
    this.#sendReauthorizationCard = options.sendReauthorizationCard ?? null;
    this.#sendReauthorizationMessage = options.sendReauthorizationMessage ?? null;
    this.#logger = options.logger ?? {
      warn: (context, message) => console.warn(message, context)
    };
    this.#stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1_000;
    this.#refreshSkewMs = options.refreshSkewMs ?? 10 * 60 * 1_000;
    this.#staleEventMs = options.staleEventMs ?? 24 * 60 * 60 * 1_000;
    this.#now = options.now ?? (() => new Date());
  }

  createAuthorizationUrl(): string {
    const state = this.#stateStore.issue({
      now: this.#now(),
      ttlMs: this.#stateTtlMs
    });
    const url = new URL(this.#authBaseUrl);
    url.searchParams.set('client_id', this.#appId);
    url.searchParams.set('redirect_uri', this.#redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (this.#scopes.length > 0) {
      url.searchParams.set('scope', this.#scopes.join(' '));
    }
    return url.toString();
  }

  async completeCallback(input: { code: string; state: string }): Promise<{
    openId: string;
    subscriptionStatus: OAuthSubscriptionStatus;
  }> {
    const now = this.#now();
    if (!this.#stateStore.consume({ state: input.state, now })) {
      throw new OAuthStateError();
    }
    const token = await this.#client.exchangeCode({
      code: input.code,
      redirectUri: this.#redirectUri
    });
    this.#tokenRepository.saveToken({
      openId: token.openId,
      userAccessToken: token.userAccessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: new Date(now.getTime() + token.expiresInSeconds * 1_000),
      refreshTokenExpiresAt: new Date(now.getTime() + token.refreshExpiresInSeconds * 1_000),
      authorizationStatus: 'valid',
      subscriptionStatus: 'unsubscribed',
      now
    });
    try {
      await this.#client.subscribeMinuteGenerated(token.userAccessToken);
      this.#tokenRepository.markSubscriptionStatus(token.openId, 'subscribed', this.#now());
      return { openId: token.openId, subscriptionStatus: 'subscribed' };
    } catch (error) {
      this.#tokenRepository.markSubscriptionStatus(token.openId, 'failed', this.#now());
      this.#logger.warn({
        err: error,
        openId: token.openId,
        subscriptionStatus: 'failed'
      }, 'Feishu minute event subscription failed after OAuth token storage');
      return { openId: token.openId, subscriptionStatus: 'failed' };
    }
  }

  async ensureFreshToken(openId: string): Promise<
    | { status: 'missing' }
    | { status: 'fresh' }
    | { status: 'refreshed' }
    | { status: 'reauthorization_required' }
  > {
    const record = this.#tokenRepository.findByOpenId(openId);
    if (!record) {
      return { status: 'missing' };
    }
    const now = this.#now();
    if (record.authorizationStatus !== 'valid') {
      await this.#sendReauthorization(openId, now);
      return { status: 'reauthorization_required' };
    }
    const expiresAt = new Date(record.accessTokenExpiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt - now.getTime() > this.#refreshSkewMs) {
      return { status: 'fresh' };
    }
    try {
      const token = await this.#client.refreshToken(record.refreshToken);
      this.#tokenRepository.saveToken({
        openId: token.openId,
        userAccessToken: token.userAccessToken,
        refreshToken: token.refreshToken,
        accessTokenExpiresAt: new Date(now.getTime() + token.expiresInSeconds * 1_000),
        refreshTokenExpiresAt: new Date(now.getTime() + token.refreshExpiresInSeconds * 1_000),
        authorizationStatus: 'valid',
        subscriptionStatus: record.subscriptionStatus,
        now
      });
      return { status: 'refreshed' };
    } catch {
      this.#tokenRepository.markInvalid(openId, now);
      await this.#sendReauthorization(openId, now);
      return { status: 'reauthorization_required' };
    }
  }

  diagnostics(): { users: OAuthDiagnosticUser[] } {
    const nowMs = this.#now().getTime();
    return {
      users: this.#tokenRepository.list().map((record) => {
        const accessTokenExpiresAtMs = new Date(record.accessTokenExpiresAt).getTime();
        const refreshTokenExpiresAtMs = new Date(record.refreshTokenExpiresAt).getTime();
        const lastEventMs = record.lastEventAt ? new Date(record.lastEventAt).getTime() : NaN;
        const expired = Number.isFinite(accessTokenExpiresAtMs) && accessTokenExpiresAtMs <= nowMs;
        return {
          openId: record.openId,
          authorized: record.authorizationStatus === 'valid' &&
            (!Number.isFinite(refreshTokenExpiresAtMs) || refreshTokenExpiresAtMs > nowMs),
          expired,
          subscribed: record.subscriptionStatus === 'subscribed',
          lastEventAt: record.lastEventAt,
          stale: !Number.isFinite(lastEventMs) || nowMs - lastEventMs > this.#staleEventMs,
          authorizationStatus: record.authorizationStatus,
          subscriptionStatus: record.subscriptionStatus,
          accessTokenExpiresAt: record.accessTokenExpiresAt,
          refreshTokenExpiresAt: record.refreshTokenExpiresAt,
          updatedAt: record.updatedAt
        };
      })
    };
  }

  async recordRevocation(openId: string): Promise<void> {
    const now = this.#now();
    this.#tokenRepository.markInvalid(openId, now);
    await this.#sendReauthorization(openId, now);
  }

  recordMinuteEvent(event: unknown): void {
    const parsed = z.object({
      subscriber_ids: z.array(z.object({
        open_id: z.string().min(1).optional()
      }).passthrough()).optional()
    }).passthrough().safeParse(event);
    if (!parsed.success || !parsed.data.subscriber_ids) {
      return;
    }
    const now = this.#now();
    for (const subscriber of parsed.data.subscriber_ids) {
      if (subscriber.open_id) {
        this.#tokenRepository.markEventReceived(subscriber.open_id, now);
      }
    }
  }

  async #sendReauthorization(openId: string, now: Date): Promise<void> {
    if (!this.#ivyPrivateChatId || (!this.#sendReauthorizationCard && !this.#sendReauthorizationMessage)) {
      return;
    }
    const authorizationUrl = this.createAuthorizationUrl();
    const fallbackText = [
      '飞书妙记授权已过期，自动接收会议妙记事件已暂停。',
      `请点击重新授权：${authorizationUrl}`,
      `关联 open_id：${openId}`,
      `检测时间：${now.toISOString()}`
    ].join('\n');
    if (this.#sendReauthorizationCard) {
      await this.#sendReauthorizationCard({
        chatId: this.#ivyPrivateChatId,
        card: createReauthorizationCard({
          authorizationUrl,
          openId,
          detectedAt: now
        }),
        fallbackText
      });
      return;
    }
    await this.#sendReauthorizationMessage!({
      chatId: this.#ivyPrivateChatId,
      text: fallbackText
    });
  }
}

export function createReauthorizationCard(input: {
  authorizationUrl: string;
  openId: string;
  detectedAt: Date;
}): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '需要重新授权飞书妙记'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**飞书妙记授权已过期，自动接收会议妙记事件已暂停。**',
          '',
          `关联 open_id：${input.openId}`,
          `检测时间：${input.detectedAt.toISOString()}`
        ].join('\n')
      },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: '重新授权'
          },
          type: 'primary',
          url: input.authorizationUrl
        }]
      }
    ]
  };
}

export interface OAuthDiagnosticUser {
  openId: string;
  authorized: boolean;
  expired: boolean;
  subscribed: boolean;
  lastEventAt: string | null;
  stale: boolean;
  authorizationStatus: 'valid' | 'invalid';
  subscriptionStatus: OAuthSubscriptionStatus;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  updatedAt: string;
}

export class OAuthStateError extends Error {
  constructor() {
    super('invalid oauth state');
    this.name = 'OAuthStateError';
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
