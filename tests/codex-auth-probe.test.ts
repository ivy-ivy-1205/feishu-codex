import { describe, expect, it } from 'vitest';
import { CodexAuthProbe, type CodexProcessRunner } from '../src/adapters/codex-cli.js';

describe('CodexAuthProbe', () => {
  it('accepts only a successful ChatGPT login status', async () => {
    const calls: Parameters<CodexProcessRunner['run']>[0][] = [];
    const probe = new CodexAuthProbe({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      baseEnv: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'must-not-leak'
      },
      runner: {
        async run(input) {
          calls.push(input);
          return {
            exitCode: 0,
            stdout: 'Logged in with ChatGPT',
            stderr: ''
          };
        }
      }
    });

    await expect(probe.isAvailable()).resolves.toBe(true);
    expect(calls).toEqual([{
      command: 'codex',
      args: ['login', 'status'],
      cwd: '/tmp/aijia-codex-readonly',
      env: { PATH: '/usr/bin' },
      stdin: '',
      timeoutMs: 30_000
    }]);
  });

  it('rejects missing login or API-key-like auth without throwing secrets', async () => {
    const probe = new CodexAuthProbe({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      runner: {
        async run() {
          return {
            exitCode: 0,
            stdout: 'Logged in with API key',
            stderr: 'local secret should stay server-side'
          };
        }
      }
    });

    await expect(probe.isAvailable()).resolves.toBe(false);
  });

  it('fails closed when the login status command fails', async () => {
    const probe = new CodexAuthProbe({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      runner: {
        async run() {
          return {
            exitCode: 1,
            stdout: 'Not logged in',
            stderr: ''
          };
        }
      }
    });

    await expect(probe.isAvailable()).resolves.toBe(false);
  });
});
