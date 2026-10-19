import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  CodexCliAdapter,
  CodexCliError,
  NodeCodexProcessRunner,
  type CodexProcessRunner
} from '../src/adapters/codex-cli.js';

describe('CodexCliAdapter', () => {
  it('checks Codex auth before executing AI work through local Codex CLI', async () => {
    const calls: Parameters<CodexProcessRunner['run']>[0][] = [];
    const runner: CodexProcessRunner = {
      async run(input) {
        calls.push(input);
        if (input.args.join(' ') === 'login status') {
          return {
            exitCode: 0,
            stdout: 'Logged in with ChatGPT',
            stderr: ''
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ summary: 'ok' }),
          stderr: ''
        };
      }
    };
    const adapter = new CodexCliAdapter({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      baseEnv: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'must-not-leak',
        OPENAI_BASE_URL: 'https://api.example.invalid',
        OPENAI_ORG_ID: 'org-secret',
        OPENAI_PROJECT_ID: 'project-secret',
        ANTHROPIC_API_KEY: 'other-secret'
      },
      runner
    });

    await expect(adapter.executeJson({
      prompt: 'Summarize this meeting.',
      outputSchema: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: { type: 'string' }
        }
      }
    })).resolves.toEqual({ summary: 'ok' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: 'codex',
      args: ['login', 'status'],
      cwd: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      stdin: ''
    });
    expect(calls[0]?.env).toEqual({ PATH: '/usr/bin' });
    expect(calls[1]).toMatchObject({
      command: 'codex',
      cwd: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      stdin: 'Summarize this meeting.'
    });
    expect(calls[1]?.args).toEqual([
      'exec',
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="medium"',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--output-schema',
      expect.stringMatching(/meeting-summary-schema-.+\.json$/)
    ]);
    expect(calls[1]?.env).toEqual({ PATH: '/usr/bin' });
  });

  it('uses an explicitly configured model and reasoning effort instead of the account default', async () => {
    const calls: Parameters<CodexProcessRunner['run']>[0][] = [];
    const adapter = new CodexCliAdapter({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      runner: {
        async run(input) {
          calls.push(input);
          return input.args.join(' ') === 'login status'
            ? { exitCode: 0, stdout: 'Logged in with ChatGPT', stderr: '' }
            : { exitCode: 0, stdout: '{}', stderr: '' };
        }
      }
    });

    await adapter.executeJson({ prompt: 'Classify.', outputSchema: { type: 'object' } });

    expect(calls[1]?.args.slice(0, 5)).toEqual([
      'exec', '--model', 'gpt-5.6-terra', '--config', 'model_reasoning_effort="low"'
    ]);
  });

  it('fails closed without running exec when Codex auth is unavailable', async () => {
    const calls: Parameters<CodexProcessRunner['run']>[0][] = [];
    const adapter = new CodexCliAdapter({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      runner: {
        async run(input) {
          calls.push(input);
          return {
            exitCode: 1,
            stdout: 'Not logged in',
            stderr: ''
          };
        }
      }
    });

    await expect(adapter.executeJson({
      prompt: 'Summarize this meeting.',
      outputSchema: { type: 'object' }
    })).rejects.toMatchObject({
      code: 'CODEX_AUTH_REQUIRED'
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['login', 'status']
    ]);
  });

  it('requires ChatGPT login instead of accepting an API-key-like Codex auth status', async () => {
    const calls: Parameters<CodexProcessRunner['run']>[0][] = [];
    const adapter = new CodexCliAdapter({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      runner: {
        async run(input) {
          calls.push(input);
          return {
            exitCode: 0,
            stdout: 'Logged in with API key',
            stderr: ''
          };
        }
      }
    });

    await expect(adapter.executeJson({
      prompt: 'Summarize this meeting.',
      outputSchema: { type: 'object' }
    })).rejects.toMatchObject({
      code: 'CODEX_AUTH_REQUIRED'
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['login', 'status']
    ]);
  });

  it('rejects invalid JSON output without leaking stderr details', async () => {
    const adapter = new CodexCliAdapter({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      runner: {
        async run(input) {
          if (input.args.join(' ') === 'login status') {
            return {
              exitCode: 0,
              stdout: 'Logged in with ChatGPT',
              stderr: ''
            };
          }
          return {
            exitCode: 0,
            stdout: 'not json',
            stderr: 'local secret should stay server-side'
          };
        }
      }
    });

    await expect(adapter.executeJson({
      prompt: 'Summarize this meeting.',
      outputSchema: { type: 'object' }
    })).rejects.toMatchObject({
      code: 'CODEX_OUTPUT_INVALID'
    });
    await adapter.executeJson({
      prompt: 'Summarize this meeting.',
      outputSchema: { type: 'object' }
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CodexCliError);
      expect(String(error)).not.toContain('local secret');
    });
  });

  it('rejects failed Codex CLI exits as a typed execution failure', async () => {
    const adapter = new CodexCliAdapter({
      command: 'codex',
      workdir: '/tmp/aijia-codex-readonly',
      timeoutMs: 30_000,
      runner: {
        async run(input) {
          if (input.args.join(' ') === 'login status') {
            return {
              exitCode: 0,
              stdout: 'Logged in with ChatGPT',
              stderr: ''
            };
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'login expired'
          };
        }
      }
    });

    await expect(adapter.executeJson({
      prompt: 'Summarize this meeting.',
      outputSchema: { type: 'object' }
    })).rejects.toMatchObject({
      code: 'CODEX_EXECUTION_FAILED'
    });
  });
});

describe('NodeCodexProcessRunner', () => {
  it('spawns the configured process, writes stdin, and collects stdout and stderr', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    let writtenStdin = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        writtenStdin += String(chunk);
        callback();
      }
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const spawnCalls: unknown[] = [];
    const runner = new NodeCodexProcessRunner({
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return child;
      }
    });

    const resultPromise = runner.run({
      command: 'codex',
      args: ['exec'],
      cwd: '/tmp/aijia-codex-readonly',
      env: { PATH: '/usr/bin' },
      stdin: 'meeting transcript',
      timeoutMs: 1_000
    });
    child.stdout.write(Buffer.from('{"ok":true}'));
    child.stderr.write(Buffer.from('warn'));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: 'warn'
    });
    expect(writtenStdin).toBe('meeting transcript');
    expect(spawnCalls).toEqual([{
      command: 'codex',
      args: ['exec'],
      options: {
        cwd: '/tmp/aijia-codex-readonly',
        env: { PATH: '/usr/bin' },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    }]);
  });
});
