import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { MinuteContext } from '../../src/ports/feishu.js';
import type { MeetingSummaryDraft } from '../../src/ports/summarizer.js';
import { JobRepository } from '../../src/repositories/job-repository.js';
import { MeetingRepository, type MeetingTodoRecord } from '../../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../../src/repositories/outbox-repository.js';
import { processMinuteJob } from '../../src/services/meeting-worker.js';

const fixtureMinuteId = 'min_project_aware_followups';
const workerNow = new Date('2030-08-01T03:00:00.000Z');

export function createMeetingLoopFixture(prefix = 'aijia-meeting-loop-') {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), prefix));
  const databaseFilename = join(temporaryDirectory, 'bridge.sqlite');
  const database = createSqliteDatabase(databaseFilename);
  migrateDatabase(database.client);
  return {
    temporaryDirectory,
    databaseFilename,
    database,
    meetingRepository: new MeetingRepository(database.client),
    jobRepository: new JobRepository(database.client),
    outboxRepository: new OutboxRepository(database.client)
  };
}

export async function runMeetingLoopFixture(input: { transcript: string[] }): Promise<{
  renderedText: string;
  todos: MeetingTodoRecord[];
}> {
  const fixture = createMeetingLoopFixture('aijia-project-followups-');
  const {
    temporaryDirectory,
    database,
    meetingRepository,
    jobRepository,
    outboxRepository
  } = fixture;

  try {
    meetingRepository.ingestMinute({
      minuteId: fixtureMinuteId,
      eventId: 'evt_project_aware_followups'
    }, () => jobRepository.enqueueProcessMinute(fixtureMinuteId));
    const job = jobRepository.leaseNextProcessMinute(workerNow);
    if (!job) {
      throw new Error('fixture did not create a process_minute job');
    }

    const result = await processMinuteJob(job, {
      reader: {
        async getMinute(minuteId) {
          if (minuteId !== fixtureMinuteId) {
            throw new Error(`unexpected fixture minute ${minuteId}`);
          }
          return fixtureContext(input.transcript);
        }
      },
      summarizer: {
        async summarize() {
          return fakeCodexSummary;
        }
      },
      meetingRepository,
      jobRepository,
      outboxRepository,
      targetChatId: 'oc_fixture_private_chat',
      now: () => workerNow
    });
    if (result !== 'completed') {
      throw new Error(`fixture worker did not complete: ${result}`);
    }

    const summary = meetingRepository.findSummaryByMinute(fixtureMinuteId);
    const message = outboxRepository.list()[0];
    if (!summary || !message) {
      throw new Error('fixture worker did not persist a summary and outbox message');
    }
    return {
      renderedText: message.body,
      todos: meetingRepository.listTodos(summary.id)
    };
  } finally {
    database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function fixtureContext(transcript: string[]): MinuteContext {
  if (transcript.length === 0) {
    throw new Error('fixture transcript must not be empty');
  }
  return {
    minuteId: fixtureMinuteId,
    title: '项目化 follow-up fixture',
    startedAt: '2030-08-01T02:00:00.000Z',
    endedAt: '2030-08-01T02:30:00.000Z',
    transcript: transcript.map((text, index) => ({
      speakerName: 'Ivy',
      startMs: index * 1_000,
      endMs: index * 1_000 + 999,
      text
    }))
  };
}

const fakeCodexSummary: MeetingSummaryDraft = {
  oneLineConclusion: '会议 follow-up 已生成项目化 Prompt，未执行任何 Todo。',
  progress: ['使用本地 fake Codex 输出验证项目化 follow-up。'],
  decisions: ['Phase 1D 只生成 Prompt，不执行 Todo。'],
  risks: ['未知项目必须等待 Ivy 确认。'],
  todos: [
    todo('整理视频号 B-roll 优化清单', 'OpenMontage 的 B-roll 素材优化清单。', '在 OpenMontage 中整理视频号 B-roll 优化清单。'),
    todo('起草 follow-up 自动映射 Prompt', 'FeishuAdaptor 的 follow-up 自动映射 Prompt。', '在 FeishuAdaptor 中起草 follow-up 自动映射 Prompt。'),
    todo('生成 Amy Live 复测与 Demo 剪辑清单', 'Amy Live 的复测与 Demo 剪辑清单。', '在 RealAgentAI_cc 的 Amy Voice 分支生成复测与 Demo 剪辑清单。'),
    todo('整理 compass 下一步 Prompt', 'compass 的下一步项目化 Prompt。', '在 aijia-compass-work 中整理下一步 Prompt。'),
    todo('澄清新实验所属项目', '没命名的新实验，不能猜测项目。', '请 Ivy 先确认新实验所属项目，再生成下一步 Prompt。')
  ]
};

function todo(
  title: string,
  description: string,
  projectPrompt: string
) {
  return {
    title,
    description,
    risk: 'low' as const,
    capability: 'content_draft' as const,
    projectKey: null,
    subprojectKey: null,
    projectConfidence: 'low' as const,
    projectEvidence: '会议没有足够证据',
    projectPrompt
  };
}
