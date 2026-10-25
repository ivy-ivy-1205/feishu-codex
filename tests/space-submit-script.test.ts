import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workspaces: string[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true }); });

const title = 'AiJia 合伙人对齐室项目总览';
const titleB64 = Buffer.from(title).toString('base64');
const page = '更新于 2026 年 10 月 25 日\n\n# 正在做\n\nPhase 6 资料接入。\n';
const nodeOut = '{"projectKey":"feishu-adaptor","syncId":"auto-page_c-20261026T010000Z","unchanged":false}';

/** A copy of the forced command under a scratch root, with a fake `docker` that records every call. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'space-submit-'));
  workspaces.push(root);
  for (const dir of ['bin', 'config', 'fake', 'container']) mkdirSync(join(root, dir));
  copyFileSync(resolve('deploy/space-submit.sh'), join(root, 'bin/space-submit.sh'));
  chmodSync(join(root, 'bin/space-submit.sh'), 0o755);
  writeFileSync(join(root, 'config/space-submit-allowlist'), 'feishu-adaptor\n');
  writeFileSync(join(root, 'fake/docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ROOT/docker.log"
case "$1" in
  cp) cp "$2" "$FAKE_ROOT/container/$(basename "\${3#*:}")"; cp "$2" "$FAKE_ROOT/received.md";;
  exec) for arg in "$@"; do case "$arg" in rm) rm -f "$FAKE_ROOT/container/"*; exit 0;; node) printf '%s\\n' "$FAKE_NODE_OUT"; exit "$FAKE_NODE_RC";; esac; done;;
esac
exit 0
`);
  chmodSync(join(root, 'fake/docker'), 0o755);
  const run = (command: string, input = page, env: Record<string, string> = {}) => spawnSync('sh', [join(root, 'bin/space-submit.sh')], {
    input, encoding: 'utf8', env: { PATH: `${join(root, 'fake')}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command,
      FAKE_ROOT: root, FAKE_NODE_OUT: nodeOut, FAKE_NODE_RC: '0', ...env } });
  const dockerCalls = () => existsSync(join(root, 'docker.log')) ? readFileSync(join(root, 'docker.log'), 'utf8').trim().split('\n') : [];
  const log = () => readFileSync(join(root, 'logs/space-submit.log'), 'utf8');
  const leftovers = () => [...readdirSync(join(root, 'space-submit')), ...readdirSync(join(root, 'container'))];
  return { root, run, dockerCalls, log, leftovers };
}

describe('Space auto-submit forced command', () => {
  it('hands one allowed page read to space-auto-submit and logs counts, never page text', () => {
    const h = harness();
    const result = h.run(`submit feishu-adaptor 2026-10-25T11:22:59.146250Z ${titleB64}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(nodeOut);
    expect(readFileSync(join(h.root, 'received.md'), 'utf8')).toBe(page);
    const exec = h.dockerCalls().find((call) => call.includes('space-auto-submit'));
    expect(exec).toContain('feishu-codex-bridge node dist/cli/space-auto-submit.js --project-key feishu-adaptor');
    expect(exec).toContain(`--title=${title} --updated-at 2026-10-25T11:22:59.146250Z`);
    expect(h.log()).toMatch(/OK key=feishu-adaptor bytes=\d+ \{"projectKey"/u);
    expect(h.log()).not.toContain('资料接入');
    expect(h.leftovers()).toEqual([]);
  });

  it('refuses anything but the one submit shape, before touching docker', () => {
    const h = harness();
    for (const command of ['', 'bash', `submit feishu-adaptor 2026-10-25T11:22:59Z ${titleB64} extra`,
      `submit feishu-adaptor;id 2026-10-25T11:22:59Z ${titleB64}`, `submit ../etc 2026-10-25T11:22:59Z ${titleB64}`,
      `submit feishu-adaptor * ${titleB64}`]) {
      const result = h.run(command);
      expect(result.status, command).toBe(2);
    }
    expect(h.run(`submit smart-listing 2026-10-25T11:22:59Z ${titleB64}`).stderr).toContain('SPACE_SUBMIT_PROJECT_NOT_ALLOWED');
    expect(h.run('submit feishu-adaptor 10-25 ' + titleB64).stderr).toContain('SPACE_SUBMIT_UPDATED_AT_INVALID');
    expect(h.run('submit feishu-adaptor 2026-10-25T11:22:59Z not*base64').stderr).toContain('SPACE_SUBMIT_TITLE_INVALID');
    expect(h.run(`submit feishu-adaptor 2026-10-25T11:22:59Z ${Buffer.from('a\nb').toString('base64')}`).stderr)
      .toContain('SPACE_SUBMIT_TITLE_INVALID');
    expect(h.dockerCalls()).toEqual([]);
    expect(h.log()).toContain('REJECT SPACE_SUBMIT_COMMAND_INVALID');
  });

  it('refuses an empty or oversized read without copying it anywhere', () => {
    const h = harness();
    const command = `submit feishu-adaptor 2026-10-25T11:22:59Z ${titleB64}`;
    expect(h.run(command, '').stderr).toContain('SPACE_SUBMIT_EMPTY');
    expect(h.run(command, 'x'.repeat(1_000_001)).stderr).toContain('SPACE_SUBMIT_TOO_LARGE');
    expect(h.dockerCalls()).toEqual([]);
    expect(h.leftovers()).toEqual([]);
  });

  it('passes a failed import back as a failure and still removes the copies', () => {
    const h = harness();
    const result = h.run(`submit feishu-adaptor 2026-10-25T11:22:59Z ${titleB64}`, page,
      { FAKE_NODE_OUT: 'SPACE_AUTO_SUBMIT_PROJECT_NOT_REGISTERED. No page content logged.', FAKE_NODE_RC: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SPACE_AUTO_SUBMIT_PROJECT_NOT_REGISTERED');
    expect(h.log()).toContain('FAIL key=feishu-adaptor');
    expect(h.leftovers()).toEqual([]);
  });
});
