import type { MinuteContext } from '../ports/feishu.js';
import {
  parseMeetingSummaryDraft,
  type MeetingSummarizer,
  type MeetingSummaryDraft
} from '../ports/summarizer.js';

export interface CodexJsonExecutor {
  executeJson(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface CodexMeetingSummarizerOptions {
  codex: CodexJsonExecutor;
}

export const meetingSummaryOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['oneLineConclusion', 'progress', 'decisions', 'risks', 'todos'],
  properties: {
    oneLineConclusion: {
      type: 'string',
      minLength: 1
    },
    progress: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1 }
    },
    decisions: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1 }
    },
    risks: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1 }
    },
    todos: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'risk', 'capability'],
        properties: {
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          risk: { enum: ['low', 'high'] },
          capability: {
            enum: [
              'unknown',
              'content_draft',
              'code_write',
              'external_message',
              'deploy',
              'delete',
              'production_access'
            ]
          }
        }
      }
    }
  }
} as const satisfies Record<string, unknown>;

export class CodexMeetingSummarizer implements MeetingSummarizer {
  readonly #codex: CodexJsonExecutor;

  constructor(options: CodexMeetingSummarizerOptions) {
    this.#codex = options.codex;
  }

  async summarize(context: MinuteContext): Promise<MeetingSummaryDraft> {
    return parseMeetingSummaryDraft(
      await this.#codex.executeJson({
        prompt: renderMeetingSummaryPrompt(context),
        outputSchema: meetingSummaryOutputSchema
      })
    );
  }
}

function renderMeetingSummaryPrompt(context: MinuteContext): string {
  return [
    '你是 AiJia 的 Codex 会议助手。请基于飞书妙记逐字稿，生成给 Ivy 的个性化会后总结。',
    '',
    '输出必须严格符合 JSON schema。不要输出 Markdown、解释或额外字段。',
    'oneLineConclusion 是给 Ivy 的第一眼结论：概括本次会议最重要的判断，不限制字数。',
    'progress 只放事实进展；decisions 只放已经确认的决策；risks 只放风险、卡点或仍未验证的假设。',
    '',
    '判断 Todo 时遵守这些边界：',
    '- Todo 生成不代表执行授权。',
    '- 只把 Codex 真正可以协助推进的事项列为 todos。',
    '- 不要把需要人际判断、线下行动或外部发送的事项伪装成 Codex 可独立完成。',
    '- 代码修改、对外发送、部署、删除、生产访问必须标为 high risk 和对应 capability。',
    '- 没有可推进 Todo 时返回空 todos，但 oneLineConclusion 仍必须诚实总结。',
    '',
    `minute_id: ${context.minuteId}`,
    `title: ${context.title}`,
    `started_at: ${context.startedAt}`,
    `ended_at: ${context.endedAt}`,
    '',
    'transcript:',
    ...context.transcript.map((segment) => (
      `${segment.speakerName} [${segment.startMs}-${segment.endMs}ms]: ${segment.text}`
    ))
  ].join('\n');
}
