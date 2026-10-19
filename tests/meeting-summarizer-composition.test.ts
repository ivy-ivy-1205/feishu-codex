import { describe, expect, it } from 'vitest';
import { CodexMeetingSummarizer } from '../src/adapters/codex-summarizer.js';
import { CodexAuthProbe, CodexCliAdapter, NodeCodexProcessRunner } from '../src/adapters/codex-cli.js';
import { createMeetingSummarizer } from '../src/composition/meeting-summarizer.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { ProjectRepositoryContextProvider } from '../src/services/project-context.js';
import { createTestMeetingRepository } from './helpers/test-db.js';
import { seedLegacyProjectRegistryFixture } from './helpers/project-registry-fixtures.js';

const baseConfig = {
  codex: {
    command: 'codex',
    workdir: '/tmp/aijia-codex-readonly',
    timeoutSeconds: 120,
    summarizerMode: 'fake'
  }
} as const;

describe('createMeetingSummarizer', () => {
  it('builds project cards from active registry projects and their newest persisted snapshot', async () => {
    const database = createTestMeetingRepository();
    seedLegacyProjectRegistryFixture(database.client);
    database.client.prepare(`
      INSERT INTO project_context_snapshots (
        id, project_key, source_kind, source_ref, content, digest, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'snapshot:openmontage:newest',
      'openmontage',
      'manual',
      'fixture',
      '最新 OpenMontage 上下文。',
      'fixture-digest',
      '2026-07-31T12:00:00.000Z'
    );
    const provider = new ProjectRepositoryContextProvider(new ProjectRepository(database.client));

    const cards = await provider.getProjectCards();

    expect(cards.find((card) => card.projectKey === 'openmontage')).toMatchObject({
      displayName: 'OpenMontage',
      summary: '最新 OpenMontage 上下文。'
    });
    expect(cards.find((card) => card.projectKey === 'feishu-adaptor')?.summary)
      .toContain('FeishuAdaptor');
  });

  it('caps persisted snapshot text before it can become prompt context', async () => {
    const database = createTestMeetingRepository();
    seedLegacyProjectRegistryFixture(database.client);
    database.client.prepare(`
      INSERT INTO project_context_snapshots (
        id, project_key, source_kind, source_ref, content, digest, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'snapshot:feishu-adaptor:large',
      'feishu-adaptor',
      'manual',
      'fixture',
      '界'.repeat(2_000),
      'fixture-digest-large',
      '2026-07-31T12:00:00.000Z'
    );
    const provider = new ProjectRepositoryContextProvider(new ProjectRepository(database.client));

    const card = (await provider.getProjectCards())
      .find((candidate) => candidate.projectKey === 'feishu-adaptor');

    expect(Buffer.byteLength(card?.summary ?? '', 'utf8')).toBeLessThanOrEqual(4 * 1024 + 3);
    expect(card?.summary).toMatch(/…$/);
  });

  it('keeps production composition on fake summarizer by default', async () => {
    const summarizer = createMeetingSummarizer({
      config: baseConfig,
      env: { PATH: '/usr/bin' }
    });

    await expect(summarizer.summarize({
      minuteId: 'min_comp_1',
      title: 'AI Native 周会',
      startedAt: '2026-07-18T02:00:00.000Z',
      endedAt: '2026-07-18T02:30:00.000Z',
      transcript: [{
        speakerName: 'Ivy',
        startMs: 0,
        endMs: 1_000,
        text: '默认不能调用真实 Codex。'
      }]
    })).resolves.toMatchObject({
      oneLineConclusion: '当前 summarizer 仍使用 fake 模式，尚未启用真实 Codex。',
      progress: ['当前 summarizer 仍使用 fake 模式，尚未启用真实 Codex。'],
      todos: []
    });
  });

  it('wires CodexMeetingSummarizer only when CODEX_SUMMARIZER_MODE is codex', () => {
    const summarizer = createMeetingSummarizer({
      config: {
        ...baseConfig,
        codex: {
          ...baseConfig.codex,
          summarizerMode: 'codex'
        }
      },
      env: { PATH: '/usr/bin' }
    });

    expect(summarizer).toBeInstanceOf(CodexMeetingSummarizer);
  });

  it('builds the Codex CLI execution stack with configured command, workdir, timeout, and env', async () => {
    const database = createTestMeetingRepository();
    seedLegacyProjectRegistryFixture(database.client);
    const stack = createMeetingSummarizer({
      config: {
        ...baseConfig,
        codex: {
          command: '/usr/local/bin/codex',
          workdir: '/opt/feishu-codex/codex-workdir',
          timeoutSeconds: 90,
          summarizerMode: 'codex'
        }
      },
      env: { PATH: '/usr/bin' },
      projectRepository: new ProjectRepository(database.client),
      exposeInternalsForTest: true
    });

    expect(stack.summarizer).toBeInstanceOf(CodexMeetingSummarizer);
    expect(stack.codex).toBeInstanceOf(CodexCliAdapter);
    expect(stack.authProbe).toBeInstanceOf(CodexAuthProbe);
    expect(stack.runner).toBeInstanceOf(NodeCodexProcessRunner);
    expect(stack.codexOptions).toEqual({
      command: '/usr/local/bin/codex',
      workdir: '/opt/feishu-codex/codex-workdir',
      timeoutMs: 90_000,
      baseEnv: { PATH: '/usr/bin' }
    });
    expect(stack.projectContextProvider).toBeInstanceOf(ProjectRepositoryContextProvider);
    await expect(stack.projectContextProvider.getProjectCards()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectKey: 'feishu-adaptor', displayName: 'FeishuAdaptor' })
      ])
    );
  });
});
