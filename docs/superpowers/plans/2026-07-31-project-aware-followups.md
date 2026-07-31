# Phase 1D Project-Aware Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn meeting follow-ups from generic Todo titles into project-mapped, evidence-backed, Ivy-correctable project prompts without automatically executing tasks.

**Architecture:** Add a Project Registry as the stable boundary between meeting content and workspaces. Codex summarization receives compact project cards, emits project mapping metadata for each Todo, and a deterministic post-processor applies long-lived Ivy correction rules before persistence and rendering.

**Tech Stack:** Node.js 20+, TypeScript, Zod 4, Vitest 3, Fastify 5, Feishu Node SDK, SQLite, Docker Compose, server-local Codex CLI only.

## Global Constraints

- No OpenAI API Key fallback; all AI work stays through the server-local Codex CLI and Ivy's existing Codex/ChatGPT login.
- Do not execute generated Todos in Phase 1D; output only project-aware prompts and metadata.
- Production deployment, server commands, Feishu history sync, env changes, crontab edits, and service restarts still require Ivy's explicit approval.
- Default delivery remains Ivy private chat; do not publish summaries to project groups automatically.
- Only read the approved Feishu context group `oc_a84d5b6ca478220d0a37964b50776edb`; do not read non-whitelisted groups or private chats.
- Feishu context ingestion skips video and ordinary audio files; native voice messages may be represented as missing text unless an approved ASR path is wired separately.
- Persist source coverage and gaps; never describe partial Feishu history or partial file access as complete sync.
- Local Mac paths are hints only. Production cannot directly read `/Users/mengxi/...`; use GitHub, server checkout, or synced project-context snapshots.
- Low-confidence mappings render as `[待确认项目]`.
- Long-lived Ivy corrections apply by default, but conflicting new context must surface for Ivy judgment instead of silently overriding.

---

## File Structure

- `src/domain/project.ts`: Project Registry Zod schemas, stable enums, seed types, mapping result types, and bounded text helpers.
- `src/domain/meeting.ts`: persisted Todo schema additions for project mapping fields and optional dismissal status.
- `src/db/schema.ts`: Drizzle declarations for registry tables and new `meeting_todos` columns.
- `src/db/migrate.ts`: SQLite migration for registry tables, idempotent seed rows, and backward-compatible `meeting_todos` column additions.
- `src/services/project-registry-seed.ts`: initial project definitions and mapping rules approved by Ivy.
- `src/repositories/project-repository.ts`: read/write APIs for projects, mapping rules, context snapshots, conflicts, and corrections.
- `src/repositories/meeting-repository.ts`: persist and read project-aware Todo fields.
- `src/services/project-context.ts`: compact project card provider and prompt renderer.
- `src/services/project-mapper.ts`: deterministic rule matcher and summarizer-output normalizer.
- `src/adapters/codex-summarizer.ts`: output schema/prompt upgrades so Codex emits project-aware follow-ups.
- `src/ports/summarizer.ts`: Zod validation for new Todo fields.
- `src/services/meeting-worker.ts`: enrich summary Todos with registry-backed mapping before render/persist.
- `src/services/summary-renderer.ts`: display project labels and confidence in the “我可以帮你推进” list.
- `src/services/reply-router.ts`: parse Ivy correction replies before execution replies.
- `src/domain/authorization.ts`: add correction/dismissal reply decision variants.
- `src/routes/feishu-events.ts`: acknowledge correction replies in private chat.
- `src/services/feishu-context-sync.ts`: approved-group context snapshot builder interface and safe media/file skip accounting.
- `src/adapters/feishu-sdk.ts`: Feishu group message/file listing boundary if the SDK already exposes the needed APIs; otherwise wrap the minimum API methods behind an internal interface.
- `src/config.ts`: optional feature flags for project context sync and staleness thresholds.
- `deploy/bridge.env.example`: documented but disabled context-sync settings.
- `docs/tencent-cloud-deployment.md`: operator notes for project registry, context sync, and approval gates.
- Tests under `tests/` mirror the files above and must be added before implementation.

---

### Task 1: Project Registry domain, SQLite tables, and seed data

**Files:**
- Create: `src/domain/project.ts`
- Create: `src/services/project-registry-seed.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Test: `tests/project-domain.test.ts`
- Test: `tests/migrate.test.ts`
- Test: `tests/meeting-repository.test.ts`

**Interfaces:**
- Produces: `ProjectKey`, `ProjectDefinition`, `ProjectMappingRule`, `ProjectMappingStatus`, `ProjectConfidence`, `ProjectMappingDraft`.
- Produces: `initialProjectDefinitions: readonly ProjectDefinition[]`.
- Produces: `initialProjectMappingRules: readonly ProjectMappingRule[]`.
- Produces SQLite tables `projects`, `project_mapping_rules`, `project_context_snapshots`, `project_mapping_conflicts`.
- Produces new nullable `meeting_todos` columns: `project_key`, `subproject_key`, `project_confidence`, `project_evidence`, `project_mapping_status`, `project_prompt`.

- [ ] **Step 1: Write failing domain tests**

Add `tests/project-domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ProjectDefinition,
  ProjectMappingDraft,
  ProjectMappingRule
} from '../src/domain/project.js';
import {
  initialProjectDefinitions,
  initialProjectMappingRules
} from '../src/services/project-registry-seed.js';

describe('Project Registry domain', () => {
  it('validates Ivy approved initial projects', () => {
    expect(initialProjectDefinitions.map((project) => project.projectKey)).toEqual([
      'feishu-adaptor',
      'openmontage',
      'aijia-landingpage',
      'realagent-ai-cc',
      'ljhooker-audiobooks',
      'ivy-xhs',
      'james-wechat',
      'family-first-ai-os',
      'aijia-compass-work'
    ]);
    for (const project of initialProjectDefinitions) {
      expect(ProjectDefinition.safeParse(project).success).toBe(true);
    }
  });

  it('validates deterministic keyword and correction rules', () => {
    expect(initialProjectMappingRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pattern: 'Amy Live',
        projectKey: 'realagent-ai-cc',
        subprojectKey: 'amy-voice'
      }),
      expect.objectContaining({
        pattern: 'compass',
        projectKey: 'aijia-compass-work'
      })
    ]));
    for (const rule of initialProjectMappingRules) {
      expect(ProjectMappingRule.safeParse(rule).success).toBe(true);
    }
  });

  it('rejects invalid project mapping confidence and status values', () => {
    expect(ProjectMappingDraft.safeParse({
      projectKey: null,
      subprojectKey: null,
      confidence: 'certain',
      evidence: 'model guessed',
      status: 'mapped',
      projectPrompt: '请处理这个任务。'
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing domain test**

Run:

```bash
pnpm test -- tests/project-domain.test.ts
```

Expected: FAIL because `src/domain/project.ts` and `src/services/project-registry-seed.ts` do not exist.

- [ ] **Step 3: Add domain schemas and seed constants**

Create `src/domain/project.ts` with the exact exported names used by the test. Use these enum values:

```ts
export const projectConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const projectMappingStatusSchema = z.enum([
  'mapped',
  'needs_confirmation',
  'unmapped',
  'dismissed'
]);
export const projectRuleSourceSchema = z.enum(['system', 'ivy_correction']);
export const projectRulePatternKindSchema = z.enum(['keyword', 'exact', 'regex']);
export const projectStatusSchema = z.enum(['active', 'archived']);
```

Create `src/services/project-registry-seed.ts` with the approved first-batch data:

```ts
export const initialProjectDefinitions = [
  {
    projectKey: 'feishu-adaptor',
    displayName: 'FeishuAdaptor',
    aliases: ['feishu codex', '飞书 codex', 'bridge', 'project 6'],
    localPathHint: '/Users/mengxi/Projects/FeishuAdaptor',
    repoUrl: 'https://github.com/ivy-ivy-1205/feishu-codex',
    defaultBranch: 'main',
    status: 'active'
  },
  {
    projectKey: 'openmontage',
    displayName: 'OpenMontage',
    aliases: ['B-roll', 'A-roll', '视频合成', 'timeline', 'Backlot'],
    localPathHint: '/Users/mengxi/Projects/OpenMontage',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'aijia-landingpage',
    displayName: 'aijia-landingpage',
    aliases: ['首页', 'landing page', 'Hero', '官网首页'],
    localPathHint: '/Users/mengxi/Documents/aijia-landingpage',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'realagent-ai-cc',
    displayName: 'RealAgentAI_cc',
    aliases: ['Amy Live', 'Amy 语音通话', 'Amy Wechat', '买家 Amy', 'SmartListing Amy'],
    localPathHint: '/Users/mengxi/Desktop/RealAgentAI_cc',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'ljhooker-audiobooks',
    displayName: 'ljhooker-audiobooks',
    aliases: ['静姐有声书', '有声书', 'audiobook'],
    localPathHint: '/Users/mengxi/Projects/ljhooker-audiobooks',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'ivy-xhs',
    displayName: 'ivy-xhs',
    aliases: ['小红书', 'XHS', 'rednote'],
    localPathHint: '/Users/mengxi/Projects/ivy-xhs',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'james-wechat',
    displayName: 'James公众号',
    aliases: ['公众号', 'James公众号', 'James 公众号', '微信文章'],
    localPathHint: '/Users/mengxi/Projects/content_creation/wechat_duanshipin/productions/2026-W23',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'family-first-ai-os',
    displayName: 'family-first-ai-os',
    aliases: ['family first', 'Family First'],
    localPathHint: '/Users/mengxi/Projects/family-first-ai-os',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  },
  {
    projectKey: 'aijia-compass-work',
    displayName: 'aijia-compass-work',
    aliases: ['compass'],
    localPathHint: '/Users/mengxi/Projects/aijia-compass-work',
    repoUrl: null,
    defaultBranch: null,
    status: 'active'
  }
] as const;
```

Add rules for the explicit mappings Ivy provided, including Amy subprojects:

```ts
export const initialProjectMappingRules = [
  { id: 'system:amy-live', pattern: 'Amy Live', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-voice', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:amy-voice', pattern: 'Amy 语音通话', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-voice', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:amy-wechat', pattern: 'Amy Wechat', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-wechat', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:buyer-amy', pattern: '买家 Amy', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-wechat', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:smartlisting-amy', pattern: 'smartlisting 上的amy', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'smartlisting-amy', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:jingjie-audiobook', pattern: '静姐有声书', patternKind: 'keyword', projectKey: 'ljhooker-audiobooks', subprojectKey: null, confidenceHint: 'high', priority: 90, source: 'system', active: true },
  { id: 'system:family-first', pattern: 'family first', patternKind: 'keyword', projectKey: 'family-first-ai-os', subprojectKey: null, confidenceHint: 'high', priority: 90, source: 'system', active: true },
  { id: 'system:landing-page', pattern: 'landing page', patternKind: 'keyword', projectKey: 'aijia-landingpage', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:homepage', pattern: '首页', patternKind: 'keyword', projectKey: 'aijia-landingpage', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:wechat-official-account', pattern: '公众号', patternKind: 'keyword', projectKey: 'james-wechat', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:xhs', pattern: '小红书', patternKind: 'keyword', projectKey: 'ivy-xhs', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:compass', pattern: 'compass', patternKind: 'keyword', projectKey: 'aijia-compass-work', subprojectKey: null, confidenceHint: 'high', priority: 90, source: 'system', active: true }
] as const;
```

- [ ] **Step 4: Add SQLite tables and migrations**

Add Drizzle tables and `migrateDatabase()` SQL for:

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  local_path_hint TEXT,
  repo_url TEXT,
  default_branch TEXT,
  status TEXT NOT NULL CONSTRAINT projects_status_allowed CHECK(status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_mapping_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  pattern_kind TEXT NOT NULL CONSTRAINT project_mapping_rules_pattern_kind_allowed CHECK(pattern_kind IN ('keyword', 'exact', 'regex')),
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  subproject_key TEXT,
  confidence_hint TEXT NOT NULL CONSTRAINT project_mapping_rules_confidence_allowed CHECK(confidence_hint IN ('high', 'medium', 'low')),
  priority INTEGER NOT NULL,
  source TEXT NOT NULL CONSTRAINT project_mapping_rules_source_allowed CHECK(source IN ('system', 'ivy_correction')),
  active INTEGER NOT NULL CONSTRAINT project_mapping_rules_active_allowed CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_context_snapshots (
  id TEXT PRIMARY KEY,
  project_key TEXT REFERENCES projects(project_key),
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_mapping_conflicts (
  id TEXT PRIMARY KEY,
  todo_id TEXT REFERENCES meeting_todos(id),
  candidate_project_key TEXT,
  existing_project_key TEXT,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT project_mapping_conflicts_status_allowed CHECK(status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

Add `ALTER TABLE meeting_todos ADD COLUMN` helpers for the six new project columns. Existing rows must backfill:

```sql
project_key = NULL
subproject_key = NULL
project_confidence = 'low'
project_evidence = ''
project_mapping_status = 'unmapped'
project_prompt = ''
```

Seed the initial project definitions and system mapping rules idempotently with `INSERT ... ON CONFLICT DO UPDATE`.

- [ ] **Step 5: Run migration tests and full focused tests**

Run:

```bash
pnpm test -- tests/project-domain.test.ts tests/migrate.test.ts tests/meeting-repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/project.ts src/services/project-registry-seed.ts src/db/schema.ts src/db/migrate.ts tests/project-domain.test.ts tests/migrate.test.ts tests/meeting-repository.test.ts
git commit -m "feat: add project registry schema"
```

---

### Task 2: Project repository and deterministic rule matcher

**Files:**
- Create: `src/repositories/project-repository.ts`
- Create: `src/services/project-mapper.ts`
- Modify: `src/repositories/meeting-repository.ts`
- Test: `tests/project-repository.test.ts`
- Test: `tests/project-mapper.test.ts`
- Test: `tests/meeting-repository.test.ts`

**Interfaces:**
- Consumes: tables and seed data from Task 1.
- Produces: `ProjectRepository.listActiveProjects(): ProjectDefinition[]`.
- Produces: `ProjectRepository.listActiveRules(): ProjectMappingRule[]`.
- Produces: `ProjectRepository.recordIvyCorrection(input): ProjectMappingRule`.
- Produces: `mapTodoToProject(input, registry): ProjectMappingDraft`.

- [ ] **Step 1: Write failing repository tests**

Add `tests/project-repository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers/test-db.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';

describe('ProjectRepository', () => {
  it('lists seeded active projects and rules after migration', () => {
    const database = createTestDatabase();
    const repo = new ProjectRepository(database.client);

    expect(repo.listActiveProjects().map((project) => project.projectKey))
      .toContain('realagent-ai-cc');
    expect(repo.listActiveRules().map((rule) => rule.id))
      .toContain('system:compass');
  });

  it('records Ivy corrections as higher-priority long-lived rules', () => {
    const database = createTestDatabase();
    const repo = new ProjectRepository(database.client);

    const rule = repo.recordIvyCorrection({
      pattern: 'Hero 区',
      patternKind: 'keyword',
      projectKey: 'aijia-landingpage',
      subprojectKey: null,
      confidenceHint: 'high',
      createdAt: new Date('2026-07-31T10:00:00.000Z')
    });

    expect(rule).toMatchObject({
      source: 'ivy_correction',
      projectKey: 'aijia-landingpage',
      priority: 1000,
      active: true
    });
  });
});
```

- [ ] **Step 2: Write failing mapper tests**

Add `tests/project-mapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapTodoToProject } from '../src/services/project-mapper.js';
import {
  initialProjectDefinitions,
  initialProjectMappingRules
} from '../src/services/project-registry-seed.js';

const registry = {
  projects: [...initialProjectDefinitions],
  rules: [...initialProjectMappingRules],
  contextSnapshots: []
};

describe('mapTodoToProject', () => {
  it('maps Amy Live to RealAgent Amy Voice with high confidence', () => {
    expect(mapTodoToProject({
      title: '生成 Amy Live 复测与 Demo 剪辑清单',
      description: '验证 Amy 语音通话延迟和中文音色。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请整理复测清单。'
    }, registry)).toMatchObject({
      projectKey: 'realagent-ai-cc',
      subprojectKey: 'amy-voice',
      confidence: 'high',
      status: 'mapped'
    });
  });

  it('maps compass to aijia-compass-work', () => {
    expect(mapTodoToProject({
      title: '整理 compass 下一步',
      description: '输出项目化 prompt。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请整理 compass 下一步。'
    }, registry)).toMatchObject({
      projectKey: 'aijia-compass-work',
      confidence: 'high',
      status: 'mapped'
    });
  });

  it('keeps unknown items as needs_confirmation and renders them as pending', () => {
    expect(mapTodoToProject({
      title: '整理未命名项目的材料',
      description: '会议没有给出项目名。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请先确认项目。'
    }, registry)).toMatchObject({
      projectKey: null,
      confidence: 'low',
      status: 'needs_confirmation'
    });
  });
});
```

- [ ] **Step 3: Run focused failures**

```bash
pnpm test -- tests/project-repository.test.ts tests/project-mapper.test.ts
```

Expected: FAIL because repository and mapper are missing.

- [ ] **Step 4: Implement repository and mapper**

`ProjectRepository` must parse JSON aliases from SQLite, return only `status='active'`, return only `active=1` rules, and write correction rules with deterministic IDs:

```ts
const id = `ivy:${createHash('sha256').update(`${pattern}:${projectKey}:${subprojectKey ?? ''}`).digest('hex').slice(0, 16)}`;
```

`mapTodoToProject()` matching order:

1. Active `ivy_correction` rules by descending priority.
2. Active `system` rules by descending priority.
3. Valid summarizer-proposed project key if present in active projects.
4. Unknown result with `status='needs_confirmation'`.

Normalize match text with `NFKC`, lowercase English, and whitespace collapse. For keyword rules, match against `title + '\n' + description`. For exact rules, compare normalized strings. For regex rules, compile with `iu`; invalid regex rules must be ignored and surfaced as `project_mapping_conflicts` in Task 7.

- [ ] **Step 5: Re-run focused tests**

```bash
pnpm test -- tests/project-repository.test.ts tests/project-mapper.test.ts tests/meeting-repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/repositories/project-repository.ts src/services/project-mapper.ts src/repositories/meeting-repository.ts tests/project-repository.test.ts tests/project-mapper.test.ts tests/meeting-repository.test.ts
git commit -m "feat: map todos to registered projects"
```

---

### Task 3: Project-aware summarizer contract and prompt

**Files:**
- Modify: `src/ports/summarizer.ts`
- Modify: `src/adapters/codex-summarizer.ts`
- Create: `src/services/project-context.ts`
- Modify: `src/composition/meeting-summarizer.ts`
- Test: `tests/summarizer-schema.test.ts`
- Test: `tests/codex-summarizer.test.ts`
- Test: `tests/meeting-summarizer-composition.test.ts`

**Interfaces:**
- Consumes: `ProjectRepository` output from Task 2.
- Produces: `ProjectContextProvider.getProjectCards(): Promise<ProjectContextCard[]>`.
- Produces Todo fields `projectKey`, `subprojectKey`, `projectConfidence`, `projectEvidence`, `projectPrompt`.
- Produces Codex output schema requiring project fields for every Todo.

- [ ] **Step 1: Write failing schema tests**

Extend `tests/summarizer-schema.test.ts`:

```ts
it('requires every Todo to include project mapping metadata and a project prompt', () => {
  expect(MeetingSummaryDraft.safeParse({
    oneLineConclusion: '核心判断',
    progress: [],
    decisions: [],
    risks: [],
    todos: [{
      title: '起草 follow-up 自动映射 Prompt',
      description: '把会议 follow-up 映射到 FeishuAdaptor。',
      risk: 'low',
      capability: 'content_draft',
      projectKey: 'feishu-adaptor',
      subprojectKey: null,
      projectConfidence: 'high',
      projectEvidence: '会议明确提到 follow-up 自动映射 Prompt。',
      projectPrompt: '在 FeishuAdaptor 中设计 follow-up 自动映射 Prompt，保持 Todo 不自动执行。'
    }]
  }).success).toBe(true);
});

it('rejects a mapped Todo without project evidence or prompt', () => {
  expect(MeetingSummaryDraft.safeParse({
    oneLineConclusion: '核心判断',
    progress: [],
    decisions: [],
    risks: [],
    todos: [{
      title: '整理 B-roll 优化清单',
      description: 'OpenMontage 相关。',
      risk: 'low',
      capability: 'content_draft',
      projectKey: 'openmontage',
      subprojectKey: null,
      projectConfidence: 'high',
      projectEvidence: '',
      projectPrompt: ''
    }]
  }).success).toBe(false);
});
```

- [ ] **Step 2: Write failing prompt/schema tests**

Extend `tests/codex-summarizer.test.ts` to assert the JSON schema and prompt mention:

```ts
expect(executor.calls[0]!.outputSchema).toMatchObject({
  properties: {
    todos: {
      items: {
        required: expect.arrayContaining([
          'projectKey',
          'projectConfidence',
          'projectEvidence',
          'projectPrompt'
        ])
      }
    }
  }
});
expect(executor.calls[0]!.prompt).toContain('Project Registry');
expect(executor.calls[0]!.prompt).toContain('FeishuAdaptor');
expect(executor.calls[0]!.prompt).toContain('OpenMontage');
expect(executor.calls[0]!.prompt).toContain('无法确定时 projectKey 必须为 null');
```

- [ ] **Step 3: Run focused failures**

```bash
pnpm test -- tests/summarizer-schema.test.ts tests/codex-summarizer.test.ts tests/meeting-summarizer-composition.test.ts
```

Expected: FAIL because new fields and provider are missing.

- [ ] **Step 4: Implement schema and project card provider**

Add bounded project fields to `MeetingSummaryDraft.todos`:

```ts
projectKey: z.string().trim().min(1).nullable(),
subprojectKey: z.string().trim().min(1).nullable(),
projectConfidence: projectConfidenceSchema,
projectEvidence: boundedText('project evidence', 1024),
projectPrompt: boundedText('project prompt', 4096)
```

Create `ProjectContextProvider`:

```ts
export interface ProjectContextCard {
  projectKey: string;
  displayName: string;
  aliases: readonly string[];
  summary: string;
  localPathHint: string | null;
  repoUrl: string | null;
}

export interface ProjectContextProvider {
  getProjectCards(): Promise<ProjectContextCard[]>;
}
```

`ProjectRepositoryContextProvider` should read active projects and newest snapshots. If a project has no snapshot, render a concise fallback card from display name and aliases; do not attempt to read Mac local paths at runtime.

- [ ] **Step 5: Update Codex prompt**

Insert a compact Project Registry section before transcript:

```text
Project Registry:
- feishu-adaptor | FeishuAdaptor | aliases: feishu codex, 飞书 codex, bridge | context: ...
- openmontage | OpenMontage | aliases: B-roll, A-roll, 视频合成 | context: ...

Todo project mapping rules:
- 先使用明确关键词和会议证据，不要靠愿望猜项目。
- 无法确定时 projectKey 必须为 null，projectConfidence 为 low，projectEvidence 写“会议没有足够证据”，projectPrompt 写需要 Ivy 先确认项目的下一步问题。
- projectPrompt 是给未来 Codex task 的项目化执行提示，但当前阶段不会自动执行。
```

- [ ] **Step 6: Re-run focused tests**

```bash
pnpm test -- tests/summarizer-schema.test.ts tests/codex-summarizer.test.ts tests/meeting-summarizer-composition.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/ports/summarizer.ts src/adapters/codex-summarizer.ts src/services/project-context.ts src/composition/meeting-summarizer.ts tests/summarizer-schema.test.ts tests/codex-summarizer.test.ts tests/meeting-summarizer-composition.test.ts
git commit -m "feat: request project-aware followups"
```

---

### Task 4: Worker enrichment, persistence, and renderer labels

**Files:**
- Modify: `src/domain/meeting.ts`
- Modify: `src/repositories/meeting-repository.ts`
- Modify: `src/services/meeting-worker.ts`
- Modify: `src/services/summary-renderer.ts`
- Test: `tests/meeting-worker.test.ts`
- Test: `tests/summary-renderer.test.ts`
- Test: `tests/meeting-loop.acceptance.test.ts`

**Interfaces:**
- Consumes: `mapTodoToProject()` and `ProjectRepository`.
- Produces: persisted project-aware Todo fields.
- Produces renderer labels `[Project｜高置信度]`, `[Project｜中置信度]`, `[待确认项目]`.

- [ ] **Step 1: Write failing renderer tests**

Extend `tests/summary-renderer.test.ts`:

```ts
it('renders project labels and pending mappings in the follow-up list', () => {
  const text = renderMeetingSummary(fixtureSummary, [
    {
      displayedNumber: 1,
      title: '整理视频号 B-roll 优化清单',
      capability: 'content_draft',
      projectLabel: 'OpenMontage',
      projectConfidence: 'high',
      projectMappingStatus: 'mapped'
    },
    {
      displayedNumber: 2,
      title: '生成 Amy Live 复测与 Demo 剪辑清单',
      capability: 'content_draft',
      projectLabel: null,
      projectConfidence: 'low',
      projectMappingStatus: 'needs_confirmation'
    }
  ]);

  expect(text).toContain('1. [OpenMontage｜高置信度] 整理视频号 B-roll 优化清单');
  expect(text).toContain('2. [待确认项目] 生成 Amy Live 复测与 Demo 剪辑清单');
});
```

- [ ] **Step 2: Write failing worker persistence test**

Extend `tests/meeting-worker.test.ts`:

```ts
it('persists registry-enriched project mapping instead of trusting Codex alone', async () => {
  const result = await processFixtureMinute({
    summary: {
      ...summaryDraft,
      todos: [{
        title: '生成 Amy Live 复测与 Demo 剪辑清单',
        description: '验证 Amy 语音通话。',
        risk: 'low',
        capability: 'content_draft',
        projectKey: null,
        subprojectKey: null,
        projectConfidence: 'low',
        projectEvidence: '会议没有足够证据',
        projectPrompt: '请确认项目后整理复测清单。'
      }]
    },
    projectRegistry: seededProjectRegistry()
  });

  expect(result.todos[0]).toMatchObject({
    projectKey: 'realagent-ai-cc',
    subprojectKey: 'amy-voice',
    projectConfidence: 'high',
    projectMappingStatus: 'mapped'
  });
});
```

- [ ] **Step 3: Run focused failures**

```bash
pnpm test -- tests/summary-renderer.test.ts tests/meeting-worker.test.ts tests/meeting-loop.acceptance.test.ts
```

Expected: FAIL because render input and worker dependencies lack project fields.

- [ ] **Step 4: Implement persistence and rendering**

Extend `MeetingTodoDraft` and `MeetingTodoRecord` with:

```ts
projectKey: z.string().trim().min(1).nullable().default(null),
subprojectKey: z.string().trim().min(1).nullable().default(null),
projectConfidence: projectConfidenceSchema.default('low'),
projectEvidence: z.string().trim().max(1024).default(''),
projectMappingStatus: projectMappingStatusSchema.default('unmapped'),
projectPrompt: z.string().trim().max(4096).default('')
```

Update `processMinuteJob()` to:

1. Load registry through `ProjectRepository`.
2. Map every summarizer Todo with `mapTodoToProject()`.
3. Persist enriched mapping fields.
4. Render labels from enriched fields, not raw Codex output.

Update renderer input:

```ts
export interface MeetingTodoRenderInput {
  displayedNumber: number;
  title: string;
  capability: TodoCapability | 'human_only';
  projectLabel?: string | null;
  projectConfidence?: ProjectConfidence;
  projectMappingStatus?: ProjectMappingStatus;
}
```

Project label translation:

```ts
const confidenceLabels = { high: '高置信度', medium: '中置信度', low: '低置信度' };
```

If `projectMappingStatus !== 'mapped'` or `projectLabel === null`, render `[待确认项目]`.

- [ ] **Step 5: Re-run focused tests**

```bash
pnpm test -- tests/summary-renderer.test.ts tests/meeting-worker.test.ts tests/meeting-loop.acceptance.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/domain/meeting.ts src/repositories/meeting-repository.ts src/services/meeting-worker.ts src/services/summary-renderer.ts tests/meeting-worker.test.ts tests/summary-renderer.test.ts tests/meeting-loop.acceptance.test.ts
git commit -m "feat: render project-aware followups"
```

---

### Task 5: Ivy correction replies and long-lived rules

**Files:**
- Modify: `src/domain/authorization.ts`
- Modify: `src/services/reply-router.ts`
- Modify: `src/repositories/project-repository.ts`
- Modify: `src/repositories/meeting-repository.ts`
- Modify: `src/routes/feishu-events.ts`
- Test: `tests/reply-router.test.ts`
- Test: `tests/project-repository.test.ts`
- Test: `tests/feishu-events-route.test.ts`

**Interfaces:**
- Consumes: delivered summary reply context and project registry.
- Produces decision `{ kind: 'record_project_correction', todoId, projectKey, subprojectKey, persistentRuleCreated }`.
- Produces decision `{ kind: 'dismiss_todo', todoId }`.
- Produces acknowledgement text for corrections.

- [ ] **Step 1: Write failing reply-router tests**

Extend `tests/reply-router.test.ts`:

```ts
it('records a project correction for a numbered Todo reply', () => {
  const harness = createHarness();

  expect(harness.route({
    chatId: ivyPrivateChatId,
    openId: ivyOpenId,
    replyTo: 'om_summary_a',
    text: '3 是 RealAgentAI_cc / Amy Voice'
  })).toMatchObject({
    kind: 'record_project_correction',
    todoId: 'todo_a_3',
    projectKey: 'realagent-ai-cc',
    subprojectKey: 'amy-voice'
  });
});

it('records a long-lived keyword rule when Ivy says以后', () => {
  const harness = createHarness();

  expect(harness.route({
    chatId: ivyPrivateChatId,
    openId: ivyOpenId,
    replyTo: 'om_summary_a',
    text: '以后 B-roll 都归 OpenMontage'
  })).toMatchObject({
    kind: 'record_project_rule',
    pattern: 'B-roll',
    projectKey: 'openmontage'
  });
});

it('dismisses a Todo when Ivy says it does not need Codex', () => {
  const harness = createHarness();

  expect(harness.route({
    chatId: ivyPrivateChatId,
    openId: ivyOpenId,
    replyTo: 'om_summary_a',
    text: '这条不需要 Codex 推进：3'
  })).toMatchObject({
    kind: 'dismiss_todo',
    todoId: 'todo_a_3'
  });
});
```

- [ ] **Step 2: Run focused failures**

```bash
pnpm test -- tests/reply-router.test.ts tests/feishu-events-route.test.ts
```

Expected: FAIL because correction decisions do not exist.

- [ ] **Step 3: Implement correction parsing**

Parse these forms before execution commands:

```text
<number> 是 <project alias>
<number> 是 <project alias> / <subproject alias>
以后 <keyword> 都归 <project alias>
不是 <wrong alias>，是 <project alias>
这条不需要 Codex 推进：<number>
<number> 不需要 Codex 推进
```

Resolve project aliases with active project aliases plus explicit subproject aliases:

```ts
const subprojectAliases = {
  'Amy Voice': 'amy-voice',
  'Amy 语音通话': 'amy-voice',
  'Amy Wechat': 'amy-wechat',
  '买家 Amy': 'amy-wechat',
  'SmartListing Amy': 'smartlisting-amy'
};
```

Do not accept corrections outside Ivy private chat or without a delivered `om_` reply context, except persistent “以后 X 都归 Y” may be accepted in Ivy private chat without a summary reply when it names an active project unambiguously.

- [ ] **Step 4: Apply corrections and acknowledgements**

Add repository methods:

```ts
MeetingRepository.updateTodoProjectMapping(input: {
  todoId: string;
  projectKey: string | null;
  subprojectKey: string | null;
  projectConfidence: 'high' | 'medium' | 'low';
  projectEvidence: string;
  projectMappingStatus: 'mapped' | 'needs_confirmation' | 'unmapped' | 'dismissed';
  projectPrompt: string;
}): MeetingTodoRecord | null;

MeetingRepository.dismissTodo(todoId: string): boolean;
```

Acknowledgement text:

```text
已记录：第 3 项以后按 RealAgentAI_cc / Amy Voice 处理。若后续上下文冲突，我会先提示你判断。
```

For dismissals:

```text
已记录：第 3 项不再作为 Codex 可推进事项。
```

- [ ] **Step 5: Re-run focused tests**

```bash
pnpm test -- tests/reply-router.test.ts tests/project-repository.test.ts tests/feishu-events-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/domain/authorization.ts src/services/reply-router.ts src/repositories/project-repository.ts src/repositories/meeting-repository.ts src/routes/feishu-events.ts tests/reply-router.test.ts tests/project-repository.test.ts tests/feishu-events-route.test.ts
git commit -m "feat: record project correction replies"
```

---

### Task 6: Feishu project context snapshot foundation

**Files:**
- Create: `src/services/feishu-context-sync.ts`
- Modify: `src/adapters/feishu-sdk.ts`
- Modify: `src/repositories/project-repository.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `deploy/bridge.env.example`
- Test: `tests/feishu-context-sync.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/feishu-sdk-client.test.ts`

**Interfaces:**
- Consumes: approved Feishu group `oc_a84d5b6ca478220d0a37964b50776edb`.
- Produces: `syncFeishuProjectContext(input): Promise<FeishuContextSyncReport>`.
- Produces context snapshots with source coverage and gaps.

- [ ] **Step 1: Write failing sync tests**

Add `tests/feishu-context-sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { syncFeishuProjectContext } from '../src/services/feishu-context-sync.js';

describe('syncFeishuProjectContext', () => {
  it('stores text and document snippets from the approved group and skips video/audio', async () => {
    const snapshots: Array<{ sourceKind: string; sourceRef: string; content: string }> = [];

    const report = await syncFeishuProjectContext({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      feishu: {
        async listMessages() {
          return {
            messages: [
              { messageId: 'om_text_1', messageType: 'text', text: 'OpenMontage B-roll 需要优化。', createdAt: '2026-07-30T07:00:00.000Z' },
              { messageId: 'om_video_1', messageType: 'video', text: null, createdAt: '2026-07-30T07:01:00.000Z' }
            ],
            nextCursor: null
          };
        },
        async listReferencedFiles() {
          return [{
            fileToken: 'doc_1',
            title: 'FeishuAdaptor 方案',
            mimeType: 'application/vnd.feishu.docx',
            text: 'Project Registry 是下一阶段。'
          }];
        }
      },
      saveSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      }
    });

    expect(report).toMatchObject({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messagesRead: 2,
      mediaSkipped: 1,
      filesRead: 1
    });
    expect(snapshots.map((snapshot) => snapshot.content).join('\n')).toContain('OpenMontage B-roll');
    expect(snapshots.map((snapshot) => snapshot.content).join('\n')).toContain('Project Registry');
  });

  it('rejects non-approved chat ids before calling Feishu', async () => {
    await expect(syncFeishuProjectContext({
      chatId: 'oc_unapproved',
      approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      feishu: {
        async listMessages() {
          throw new Error('must not be called');
        },
        async listReferencedFiles() {
          throw new Error('must not be called');
        }
      },
      saveSnapshot: async () => {}
    })).rejects.toMatchObject({ code: 'FEISHU_CHAT_NOT_APPROVED' });
  });
});
```

- [ ] **Step 2: Add config tests**

Extend `tests/config.test.ts`:

```ts
expect(loadConfig({
  ...baseEnv,
  PROJECT_CONTEXT_SYNC_ENABLED: 'true',
  PROJECT_CONTEXT_CHAT_IDS: 'oc_a84d5b6ca478220d0a37964b50776edb'
}).projectContext).toMatchObject({
  syncEnabled: true,
  approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb']
});
```

- [ ] **Step 3: Run focused failures**

```bash
pnpm test -- tests/feishu-context-sync.test.ts tests/config.test.ts tests/feishu-sdk-client.test.ts
```

Expected: FAIL because sync service and config do not exist.

- [ ] **Step 4: Implement sync boundary**

Create internal Feishu context interfaces:

```ts
export interface FeishuContextMessage {
  messageId: string;
  messageType: 'text' | 'post' | 'file' | 'image' | 'video' | 'audio' | 'voice' | 'unknown';
  text: string | null;
  createdAt: string;
}

export interface FeishuContextFile {
  fileToken: string;
  title: string;
  mimeType: string;
  text: string | null;
}

export interface FeishuContextClient {
  listMessages(input: { chatId: string; cursor: string | null; since: Date }): Promise<{ messages: FeishuContextMessage[]; nextCursor: string | null }>;
  listReferencedFiles(input: { chatId: string; messageIds: readonly string[] }): Promise<FeishuContextFile[]>;
}
```

`syncFeishuProjectContext()` should:

1. Fail before API calls if `chatId` is not approved.
2. Page messages until `nextCursor === null`.
3. Store text/post text and readable file text as snapshots.
4. Count skipped media and unreadable files.
5. Save compact content chunks capped at 8 KiB each.
6. Include source refs such as `feishu:chat:<chatId>:message:<messageId>`.

Do not run this sync automatically on server startup. Add config defaults:

```env
PROJECT_CONTEXT_SYNC_ENABLED=false
PROJECT_CONTEXT_CHAT_IDS=
PROJECT_CONTEXT_SYNC_SINCE_DAYS=30
```

- [ ] **Step 5: Re-run focused tests**

```bash
pnpm test -- tests/feishu-context-sync.test.ts tests/config.test.ts tests/feishu-sdk-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/services/feishu-context-sync.ts src/adapters/feishu-sdk.ts src/repositories/project-repository.ts src/config.ts .env.example deploy/bridge.env.example tests/feishu-context-sync.test.ts tests/config.test.ts tests/feishu-sdk-client.test.ts
git commit -m "feat: add feishu project context sync boundary"
```

---

### Task 7: Conflict detection and diagnostics

**Files:**
- Modify: `src/services/project-mapper.ts`
- Modify: `src/repositories/project-repository.ts`
- Modify: `src/routes/diagnostics.ts` or create `src/routes/project-diagnostics.ts` if diagnostics are currently split by feature.
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Test: `tests/project-mapper.test.ts`
- Test: `tests/project-diagnostics.test.ts`

**Interfaces:**
- Consumes: mapping output and repository.
- Produces: `/diag/projects` read-only endpoint.
- Produces open conflict rows when system/correction/context disagree.

- [ ] **Step 1: Write failing conflict tests**

Extend `tests/project-mapper.test.ts`:

```ts
it('surfaces conflicts when Ivy correction disagrees with strong context evidence', () => {
  const result = mapTodoToProject({
    title: 'Hero 区视频设计方案',
    description: '会议同时提到 compass 工作台。',
    proposedProjectKey: 'aijia-compass-work',
    proposedSubprojectKey: null,
    proposedConfidence: 'high',
    proposedEvidence: 'Codex saw compass in transcript.',
    proposedProjectPrompt: '请处理 compass。'
  }, {
    projects: [...initialProjectDefinitions],
    rules: [{
      id: 'ivy:hero-landing',
      pattern: 'Hero 区',
      patternKind: 'keyword',
      projectKey: 'aijia-landingpage',
      subprojectKey: null,
      confidenceHint: 'high',
      priority: 1000,
      source: 'ivy_correction',
      active: true
    }],
    contextSnapshots: []
  });

  expect(result).toMatchObject({
    projectKey: 'aijia-landingpage',
    status: 'mapped'
  });
  expect(result.conflict).toMatchObject({
    existingProjectKey: 'aijia-landingpage',
    candidateProjectKey: 'aijia-compass-work'
  });
});
```

- [ ] **Step 2: Write failing diagnostics test**

Add `tests/project-diagnostics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('/diag/projects', () => {
  it('returns registry counts and open conflicts without secrets', async () => {
    const app = await buildApp(testDependenciesWithSeededProjects());
    const response = await app.inject({ method: 'GET', url: '/diag/projects' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projects: { active: 9 },
      rules: { active: expect.any(Number) },
      contextSnapshots: { total: expect.any(Number) },
      conflicts: { open: expect.any(Number) }
    });
    expect(response.body).not.toContain('user_access_token');
    expect(response.body).not.toContain('FEISHU_APP_SECRET');
  });
});
```

- [ ] **Step 3: Run focused failures**

```bash
pnpm test -- tests/project-mapper.test.ts tests/project-diagnostics.test.ts
```

Expected: FAIL because conflict and diagnostics paths are missing.

- [ ] **Step 4: Implement conflict recording and diagnostics**

If an Ivy correction rule maps to project A and Codex proposed project B with `high` confidence and non-empty evidence, keep A but return conflict metadata. The worker records that metadata through `ProjectRepository.recordMappingConflict()`.

`GET /diag/projects` returns only counts and latest timestamps:

```json
{
  "projects": { "active": 9, "archived": 0 },
  "rules": { "active": 12, "ivyCorrections": 0 },
  "contextSnapshots": { "total": 0, "latestCapturedAt": null },
  "conflicts": { "open": 0 }
}
```

Do not include raw group messages, file text, transcripts, tokens, or env values.

- [ ] **Step 5: Re-run focused tests**

```bash
pnpm test -- tests/project-mapper.test.ts tests/project-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/services/project-mapper.ts src/repositories/project-repository.ts src/routes/project-diagnostics.ts src/app.ts src/server.ts tests/project-mapper.test.ts tests/project-diagnostics.test.ts
git commit -m "feat: surface project mapping conflicts"
```

---

### Task 8: End-to-end regression and documentation

**Files:**
- Create: `tests/project-aware-followups.integration.test.ts`
- Modify: `docs/tencent-cloud-deployment.md`
- Modify: `MEMORY.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: proof that a meeting transcript produces project-aware follow-ups and no automatic task execution.

- [ ] **Step 1: Write integration fixture test**

Add `tests/project-aware-followups.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runMeetingLoopFixture } from './helpers/meeting-loop-fixture.js';

describe('project-aware followups integration', () => {
  it('maps known projects, leaves unknown items pending, and stores project prompts', async () => {
    const result = await runMeetingLoopFixture({
      transcript: [
        'Ivy: OpenMontage 的 B-roll 素材还是单薄，今天要整理优化清单。',
        'Ivy: follow-up 自动映射 Prompt 属于 FeishuAdaptor。',
        'Ivy: Amy Live 复测和 Demo 剪辑也要整理一下。',
        'Ivy: compass 下一步也要有一个 prompt。',
        'Ivy: 还有一个没命名的新实验先别猜项目。'
      ]
    });

    expect(result.renderedText).toContain('[OpenMontage｜高置信度] 整理视频号 B-roll 优化清单');
    expect(result.renderedText).toContain('[FeishuAdaptor｜高置信度] 起草 follow-up 自动映射 Prompt');
    expect(result.renderedText).toContain('[RealAgentAI_cc｜高置信度] 生成 Amy Live 复测与 Demo 剪辑清单');
    expect(result.renderedText).toContain('[aijia-compass-work｜高置信度]');
    expect(result.renderedText).toContain('[待确认项目]');
    expect(result.todos.every((todo) => todo.status === 'proposed')).toBe(true);
    expect(result.todos.every((todo) => todo.projectPrompt.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration failure**

```bash
pnpm test -- tests/project-aware-followups.integration.test.ts
```

Expected: FAIL until helper and all wiring exist.

- [ ] **Step 3: Implement helper or adapt existing acceptance helper**

Use the existing `tests/meeting-loop.acceptance.test.ts` harness as the source. Do not duplicate full worker setup if a helper can be extracted without changing test behavior. The helper must use fake Codex output and seeded Project Registry; it must not call Feishu network or Codex CLI.

- [ ] **Step 4: Update docs**

Document:

- Registry seed projects and where they came from.
- Feishu context group `oc_a84d5b6ca478220d0a37964b50776edb`.
- Production cloud cannot read Ivy Mac paths directly.
- Phase 1D only generates projectized prompts; execution remains a separate Ivy-approved action.
- `/diag/projects` read-only output.
- Context sync is disabled by default and needs production approval before running.

- [ ] **Step 5: Run full local gate**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add tests/project-aware-followups.integration.test.ts docs/tencent-cloud-deployment.md MEMORY.md
git commit -m "docs: document project-aware followups"
```

---

## Deployment and Acceptance Plan

No deployment is authorized by this plan. After implementation is complete and Ivy approves a production change order:

- Preflight:
  - Confirm `/health` and `/ready` are 200 before change.
  - Confirm active job queue and pending outbox are empty.
  - Create SQLite snapshot and verify `PRAGMA integrity_check=ok`.
  - Back up current env and confirm OAuth token key backup exists.
- Deploy:
  - Run in server `tmux`.
  - Preserve `mem_limit: 512m`, `CODEX_TIMEOUT_SECONDS=300`, `WORKER_LEASE_SECONDS=360`, and blank `WAKE_WORD`.
  - Do not run Feishu context sync during deploy unless Ivy separately approves it.
- Post-deploy:
  - `/health` 200.
  - `/ready` 200.
  - `/diag/projects` reports 9 active projects.
  - Worker queue has no stuck processing jobs except known pre-existing parser debt if still present and explicitly documented.
  - Latest backup integrity is ok.
- Product acceptance:
  - Replay or use a new meeting mentioning `B-roll`, `follow-up mapping`, `Amy Live`, `compass`, and an unknown project.
  - Verify private-chat summary labels the known projects and shows `[待确认项目]` for the unknown item.
  - Reply `以后 B-roll 都归 OpenMontage` and verify acknowledgement plus persisted correction.
  - Reply `3 是 RealAgentAI_cc / Amy Voice` and verify correction acknowledgement.
  - Confirm no Todo is executed automatically.

## Rollback Notes

- Schema changes are additive; old summaries and old Todos must remain readable.
- If rendering fails after deploy, the worker should fail closed before partial persistence rather than sending misleading project labels.
- If context sync creates bad snapshots, mark snapshots inactive or delete only the specific snapshot rows after Ivy approval; do not wipe registry projects or rules.
- If project mapping creates confusing labels, disable specific `ivy_correction` or `system` rules by setting `active=0` after Ivy approval; do not delete audit history.

## Self-Review

- Spec coverage: includes Project Registry, initial project list, keyword mappings, Feishu context group, local path caveat, projectized prompt output, long-lived correction, conflict surfacing, and low-confidence `[待确认项目]` display.
- Safety coverage: no automatic execution, no unapproved production access, no non-whitelisted Feishu reads, no media parsing expansion, no hidden API fallback.
- Type consistency: project keys use kebab-case stable IDs in code and display names keep Ivy-facing names.
- Known split: full production Feishu history backfill execution is not performed by this implementation plan; the code boundary is created, and any actual sync run requires a separate Ivy-approved operational step.
