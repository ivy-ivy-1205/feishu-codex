import type Database from 'better-sqlite3';
import { TokenCrypto } from '../services/oauth-token-crypto.js';

export type OAuthAuthorizationStatus = 'valid' | 'invalid';
export type OAuthSubscriptionStatus = 'unsubscribed' | 'subscribed' | 'failed';

export interface OAuthTokenRecord {
  openId: string;
  userAccessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  authorizationStatus: OAuthAuthorizationStatus;
  subscriptionStatus: OAuthSubscriptionStatus;
  lastEventAt: string | null;
  updatedAt: string;
}

export interface SaveOAuthTokenInput {
  openId: string;
  userAccessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  authorizationStatus: OAuthAuthorizationStatus;
  subscriptionStatus: OAuthSubscriptionStatus;
  now: Date;
}

export class OAuthTokenRepository {
  readonly #client: Database.Database;
  readonly #crypto: TokenCrypto;

  constructor(client: Database.Database, crypto: TokenCrypto) {
    this.#client = client;
    this.#crypto = crypto;
  }

  saveToken(input: SaveOAuthTokenInput): void {
    this.#client.prepare(`
      INSERT INTO feishu_user_oauth_tokens (
        open_id,
        user_access_token_ciphertext,
        refresh_token_ciphertext,
        access_token_expires_at,
        refresh_token_expires_at,
        authorization_status,
        subscription_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(open_id) DO UPDATE SET
        user_access_token_ciphertext = excluded.user_access_token_ciphertext,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        authorization_status = excluded.authorization_status,
        subscription_status = excluded.subscription_status,
        updated_at = excluded.updated_at
    `).run(
      input.openId,
      this.#crypto.encrypt(input.userAccessToken),
      this.#crypto.encrypt(input.refreshToken),
      input.accessTokenExpiresAt.toISOString(),
      input.refreshTokenExpiresAt.toISOString(),
      input.authorizationStatus,
      input.subscriptionStatus,
      input.now.toISOString()
    );
  }

  findByOpenId(openId: string): OAuthTokenRecord | null {
    const row = this.#client.prepare(`
      SELECT
        open_id,
        user_access_token_ciphertext,
        refresh_token_ciphertext,
        access_token_expires_at,
        refresh_token_expires_at,
        authorization_status,
        subscription_status,
        last_event_at,
        updated_at
      FROM feishu_user_oauth_tokens
      WHERE open_id = ?
    `).get(openId) as OAuthTokenRow | undefined;
    if (!row) {
      return null;
    }
    return {
      openId: row.open_id,
      userAccessToken: this.#crypto.decrypt(row.user_access_token_ciphertext),
      refreshToken: this.#crypto.decrypt(row.refresh_token_ciphertext),
      accessTokenExpiresAt: row.access_token_expires_at,
      refreshTokenExpiresAt: row.refresh_token_expires_at,
      authorizationStatus: row.authorization_status,
      subscriptionStatus: row.subscription_status,
      lastEventAt: row.last_event_at,
      updatedAt: row.updated_at
    };
  }

  markInvalid(openId: string, now: Date): void {
    this.#client.prepare(`
      UPDATE feishu_user_oauth_tokens
      SET authorization_status = 'invalid', updated_at = ?
      WHERE open_id = ?
    `).run(now.toISOString(), openId);
  }

  markSubscriptionStatus(openId: string, subscriptionStatus: OAuthSubscriptionStatus, now: Date): void {
    this.#client.prepare(`
      UPDATE feishu_user_oauth_tokens
      SET subscription_status = ?, updated_at = ?
      WHERE open_id = ?
    `).run(subscriptionStatus, now.toISOString(), openId);
  }

  markEventReceived(openId: string, receivedAt: Date): void {
    this.#client.prepare(`
      UPDATE feishu_user_oauth_tokens
      SET last_event_at = ?, updated_at = ?
      WHERE open_id = ?
    `).run(receivedAt.toISOString(), receivedAt.toISOString(), openId);
  }

  list(): OAuthTokenRecord[] {
    const rows = this.#client.prepare(`
      SELECT
        open_id,
        user_access_token_ciphertext,
        refresh_token_ciphertext,
        access_token_expires_at,
        refresh_token_expires_at,
        authorization_status,
        subscription_status,
        last_event_at,
        updated_at
      FROM feishu_user_oauth_tokens
      ORDER BY open_id ASC
    `).all() as OAuthTokenRow[];
    return rows.map((row) => ({
      openId: row.open_id,
      userAccessToken: this.#crypto.decrypt(row.user_access_token_ciphertext),
      refreshToken: this.#crypto.decrypt(row.refresh_token_ciphertext),
      accessTokenExpiresAt: row.access_token_expires_at,
      refreshTokenExpiresAt: row.refresh_token_expires_at,
      authorizationStatus: row.authorization_status,
      subscriptionStatus: row.subscription_status,
      lastEventAt: row.last_event_at,
      updatedAt: row.updated_at
    }));
  }
}

interface OAuthTokenRow {
  open_id: string;
  user_access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  authorization_status: OAuthAuthorizationStatus;
  subscription_status: OAuthSubscriptionStatus;
  last_event_at: string | null;
  updated_at: string;
}
