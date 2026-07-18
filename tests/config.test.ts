import { describe, expect, it } from 'vitest';
import { loadConfig, publicConfig } from '../src/config.js';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: ':memory:',
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret-value',
  FEISHU_VERIFICATION_TOKEN: 'verify-value',
  FEISHU_ENCRYPT_KEY: 'encrypt-value',
  FEISHU_ALLOWED_CHAT_IDS: 'oc_a84d5b6ca478220d0a37964b50776edb',
  FEISHU_IVY_PRIVATE_CHAT_ID: 'oc_d851c3e986007dc0f97ab582bcb2e7c8',
  FEISHU_APPROVER_OPEN_IDS: '',
  CODEX_COMMAND: 'codex',
  CODEX_WORKDIR: '/tmp/aijia-codex-readonly',
  CODEX_TIMEOUT_SECONDS: '120'
};

describe('loadConfig', () => {
  it('keeps the private chat ID separate from Ivy user identity', () => {
    const config = loadConfig(baseEnv);
    expect(config.feishu.ivyPrivateChatId).toMatch(/^oc_/);
    expect(config.feishu.approverOpenIds).toEqual([]);
  });

  it('rejects a chat ID used as an approver identity', () => {
    expect(() => loadConfig({ ...baseEnv, FEISHU_APPROVER_OPEN_IDS: 'oc_wrong' }))
      .toThrow(/open_id must start with ou_/);
  });

  it('never exposes secrets in public config', () => {
    const visible = JSON.stringify(publicConfig(loadConfig(baseEnv)));
    expect(visible).not.toContain('secret-value');
    expect(visible).not.toContain('verify-value');
    expect(visible).not.toContain('encrypt-value');
  });
});
