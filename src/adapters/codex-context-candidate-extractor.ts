import type { ContextCandidateExtractor, ContextCandidateExtractorOutput } from '../ports/context-candidate-extractor.js';
import { contextCandidateExtractorOutputSchema } from '../ports/context-candidate-extractor.js';
import type { CodexJsonExecutor } from '../ports/json-executor.js';

export interface CodexContextCandidateExtractorOptions { codex: CodexJsonExecutor }

export const contextCandidateOutputJsonSchema = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: { candidates: { type: 'array', maxItems: 12, items: {
    type: 'object', additionalProperties: false,
    required: ['candidateType', 'scope', 'summary', 'subjectKey', 'structuredPayload',
      'extractionConfidence', 'factualStatus', 'projectMappings', 'evidence',
      'suggestedRelations', 'externalRefs'],
    properties: {
      candidateType: { enum: ['proposal', 'decision', 'reported_progress', 'claim', 'risk', 'blocker', 'requirement', 'status_update', 'action_item'] },
      scope: { enum: ['company', 'project'] }, summary: { type: 'string', minLength: 1 },
      subjectKey: { type: ['string', 'null'] }, structuredPayload: { type: 'object', additionalProperties: true },
      extractionConfidence: { type: 'number', minimum: 0, maximum: 1 },
      factualStatus: { enum: ['source_attested', 'reported'] },
      projectMappings: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['projectKey', 'role', 'confidence', 'evidence'], properties: {
          projectKey: { type: ['string', 'null'] }, role: { enum: ['primary', 'related'] },
          confidence: { enum: ['high', 'medium', 'low'] }, evidence: { type: 'string', minLength: 1 }
        } } },
      evidence: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
        required: ['sourceId', 'excerpt', 'locator', 'evidenceLevel', 'role'], properties: {
          sourceId: { type: 'string', minLength: 1 }, excerpt: { type: 'string', minLength: 1 },
          locator: { type: 'object', additionalProperties: false,
            required: ['segmentOrdinal', 'sourceVersion', 'contentHash', 'speakerName', 'startMs', 'endMs'],
            properties: {
              segmentOrdinal: { type: 'integer', minimum: 0 }, sourceVersion: { type: 'integer', minimum: 1 },
              contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              speakerName: { type: 'string', minLength: 1 }, startMs: { type: 'integer', minimum: 0 },
              endMs: { type: 'integer', minimum: 0 }
            } },
          evidenceLevel: { enum: ['primary_statement', 'derived_summary'] },
          role: { enum: ['supporting', 'contradicting', 'context'] }
        } } },
      suggestedRelations: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['recordId', 'relationType', 'rationale'], properties: {
          recordId: { type: 'string', minLength: 1 },
          relationType: { enum: ['supplements', 'confirms', 'corrects', 'supersedes', 'conflicts_with', 'duplicates'] },
          rationale: { type: 'string', minLength: 1 }
        } } },
      externalRefs: { type: 'array', items: { type: 'object', additionalProperties: true } }
    }
  } } }
} as const satisfies Record<string, unknown>;

export class CodexContextCandidateExtractor implements ContextCandidateExtractor {
  readonly #codex: CodexJsonExecutor;
  constructor(options: CodexContextCandidateExtractorOptions) { this.#codex = options.codex; }

  async extract(input: Parameters<ContextCandidateExtractor['extract']>[0]): Promise<ContextCandidateExtractorOutput> {
    return contextCandidateExtractorOutputSchema.parse(await this.#codex.executeJson({
      prompt: renderContextCandidatePrompt(input), outputSchema: contextCandidateOutputJsonSchema
    }));
  }
}

function renderContextCandidatePrompt(input: Parameters<ContextCandidateExtractor['extract']>[0]): string {
  return [
    '你是企业 Context 提取器。输出只允许符合 JSON schema 的对象，不要 Markdown。',
    '候选类型仅允许 proposal, decision, reported_progress, claim, risk, blocker, requirement, status_update, action_item。',
    '每条候选必须原子化：一个可独立审核的长期决定、提议、约束、进展、陈述、风险、阻塞或项目状态变化。',
    '同一句里的多个事实、多个项目、决定与行动必须拆分；“决定上线”和“已经上线”必须拆成两个候选。',
    '纯一次性行动指令只进入 Todo，不生成 Context；action_item 仅用于具有长期约束或承诺价值的行动。',
    '事实状态只允许 source_attested 或 reported；不得输出 reviewer_confirmed 或 evidence_verified。',
    '强制默认映射：proposal/decision/requirement/action_item → source_attested。',
    '强制默认映射：reported_progress/claim/status_update/risk/blocker → reported。不得猜测或改写状态。',
    'project mapping confidence 与 extractionConfidence 完全独立，不得互相推导。',
    '每条必须引用原始 sourceId、逐字 excerpt 和稳定 locator；locator 必须逐项复制 source version、content hash、segment ordinal、speaker、startMs、endMs；最多 12 条。',
    '关系含义：supplements 补充、confirms 确认、corrects 纠正、supersedes 取代、conflicts_with 冲突、duplicates 重复。不要自动合并冲突。',
    '', 'Projects:',
    ...input.projects.map((project) => `${project.projectKey} | ${project.displayName} | ${project.summary}`),
    '', 'Existing Context:',
    ...input.existingRecords.map((record) => `${record.id} | ${record.type} | ${record.scope} | ${record.factualStatus} | ${record.summary}`),
    '', 'Sources:',
    ...input.sources.flatMap((source) => [`source_id: ${source.id}`, `source_version: ${source.sourceVersion}`, `content_hash: ${source.contentHash}`, source.contentText])
  ].join('\n');
}
