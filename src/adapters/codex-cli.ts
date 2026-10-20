import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable, Readable } from 'node:stream';

export interface CodexProcessInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
}

export interface CodexProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexProcessRunner {
  run(input: CodexProcessInput): Promise<CodexProcessOutput>;
}

export type CodexSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] }
) => CodexChildProcess;

export interface CodexChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
  once(event: 'close', listener: (exitCode: number | null) => void): unknown;
}

export interface NodeCodexProcessRunnerOptions {
  spawn?: CodexSpawn;
}

export class NodeCodexProcessRunner implements CodexProcessRunner {
  readonly #spawn: CodexSpawn;

  constructor(options: NodeCodexProcessRunnerOptions = {}) {
    this.#spawn = options.spawn ?? nodeSpawn;
  }

  async run(input: CodexProcessInput): Promise<CodexProcessOutput> {
    const child = this.#spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.end(input.stdin);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new CodexCliError('CODEX_EXECUTION_FAILED', 'Codex CLI execution timed out.'));
      }, input.timeoutMs);

      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        resolve({
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          stdout,
          stderr
        });
      });
    });
  }
}

export interface CodexCliAdapterOptions {
  command: string;
  workdir: string;
  timeoutMs: number;
  model?: CodexModel;
  reasoningEffort?: CodexReasoningEffort;
  baseEnv?: Record<string, string | undefined>;
  runner: CodexProcessRunner;
}

export type CodexModel = 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna';
export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const defaultCodexModel: CodexModel = 'gpt-5.6-sol';
export const defaultCodexReasoningEffort: CodexReasoningEffort = 'medium';

export type CodexAuthProbeOptions = CodexCliAdapterOptions;

export interface CodexJsonExecutionRequest {
  prompt: string;
  outputSchema: Record<string, unknown>;
}

export type CodexCliErrorCode =
  | 'CODEX_AUTH_REQUIRED'
  | 'CODEX_OUTPUT_INVALID'
  | 'CODEX_EXECUTION_FAILED';

export class CodexCliError extends Error {
  /** HTTP status Codex reported on stderr (e.g. 429); the stderr text itself is never kept. */
  readonly statusCode: number | null;

  constructor(readonly code: CodexCliErrorCode, message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'CodexCliError';
    this.statusCode = statusCode;
  }
}

const disallowedApiEnvKeys = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'ANTHROPIC_API_KEY'
]);

export class CodexCliAdapter {
  readonly #command: string;
  readonly #workdir: string;
  readonly #timeoutMs: number;
  readonly #model: CodexModel;
  readonly #reasoningEffort: CodexReasoningEffort;
  readonly #baseEnv: Record<string, string | undefined>;
  readonly #runner: CodexProcessRunner;
  readonly #authProbe: CodexAuthProbe;

  constructor(options: CodexCliAdapterOptions) {
    this.#command = options.command;
    this.#workdir = options.workdir;
    this.#timeoutMs = options.timeoutMs;
    this.#model = options.model ?? defaultCodexModel;
    this.#reasoningEffort = options.reasoningEffort ?? defaultCodexReasoningEffort;
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#runner = options.runner;
    this.#authProbe = new CodexAuthProbe(options);
  }

  async executeJson(request: CodexJsonExecutionRequest): Promise<unknown> {
    await this.#requireAuth();

    const schemaDirectory = await mkdtemp(join(tmpdir(), 'meeting-summary-schema-'));
    const schemaPath = join(schemaDirectory, 'schema.json');
    let result: CodexProcessOutput;
    try {
      await writeFile(schemaPath, JSON.stringify(request.outputSchema), {
        encoding: 'utf8',
        mode: 0o600
      });
      result = await this.#runner.run({
        command: this.#command,
        args: [
          'exec',
          '--model',
          this.#model,
          '--config',
          `model_reasoning_effort=${JSON.stringify(this.#reasoningEffort)}`,
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--ignore-user-config',
          '--skip-git-repo-check',
          '--output-schema',
          schemaPath
        ],
        cwd: this.#workdir,
        env: sanitizeEnv(this.#baseEnv),
        stdin: request.prompt,
        timeoutMs: this.#timeoutMs
      });
    } finally {
      await rm(schemaDirectory, { recursive: true, force: true });
    }

    if (result.exitCode !== 0) {
      const statusCode = reportedHttpStatus(result.stderr);
      throw new CodexCliError(
        'CODEX_EXECUTION_FAILED',
        `Codex CLI exited with status ${result.exitCode}${statusCode ? ` (HTTP ${statusCode})` : ''}.`,
        statusCode
      );
    }

    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new CodexCliError(
        'CODEX_OUTPUT_INVALID',
        'Codex CLI returned output that was not valid JSON.'
      );
    }
  }

  async #requireAuth(): Promise<void> {
    if (!await this.#authProbe.isAvailable()) {
      throw new CodexCliError(
        'CODEX_AUTH_REQUIRED',
        'Codex CLI must be logged in with ChatGPT before AI execution can run.'
      );
    }
  }
}

export class CodexAuthProbe {
  readonly #command: string;
  readonly #workdir: string;
  readonly #timeoutMs: number;
  readonly #baseEnv: Record<string, string | undefined>;
  readonly #runner: CodexProcessRunner;

  constructor(options: CodexAuthProbeOptions) {
    this.#command = options.command;
    this.#workdir = options.workdir;
    this.#timeoutMs = options.timeoutMs;
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#runner = options.runner;
  }

  async isAvailable(): Promise<boolean> {
    const result = await this.#runner.run({
      command: this.#command,
      args: ['login', 'status'],
      cwd: this.#workdir,
      env: sanitizeEnv(this.#baseEnv),
      stdin: '',
      timeoutMs: this.#timeoutMs
    });

    return result.exitCode === 0 && isChatGptLoginStatus(
      `${result.stdout}\n${result.stderr}`
    );
  }
}

function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => value !== undefined && !disallowedApiEnvKeys.has(key))
  ) as Record<string, string>;
}

/** The last HTTP status Codex printed, e.g. "last status: 429 Too Many Requests". */
function reportedHttpStatus(stderr: string): number | null {
  const matches = [...stderr.matchAll(/\bstatus:?\s+([1-5]\d\d)\b/giu)];
  const last = matches.at(-1)?.[1];
  return last ? Number(last) : null;
}

function isChatGptLoginStatus(stdout: string): boolean {
  const normalized = stdout.toLowerCase();
  return normalized.includes('logged in') && normalized.includes('chatgpt');
}
