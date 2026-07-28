import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production deployment contract', () => {
  it('keeps OAuth token key readable inside the container without exposing writable secrets', () => {
    const compose = readFileSync(
      new URL('../deploy/docker-compose.production.yml', import.meta.url),
      'utf8'
    );
    const envExample = readFileSync(
      new URL('../deploy/bridge.env.example', import.meta.url),
      'utf8'
    );

    expect(compose).toContain('mem_limit: 512m');
    expect(compose).toContain('/opt/feishu-codex/secrets:/app/secrets:ro');
    expect(envExample).toContain(
      'FEISHU_OAUTH_TOKEN_KEY_FILE=/app/secrets/feishu-oauth-token-key'
    );
  });
});
