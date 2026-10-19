import type Database from 'better-sqlite3';
import { z } from 'zod';
import { topicStageSchema } from '../domain/topic.js';
import { AlignmentRepository } from '../repositories/alignment-repository.js';
import { FounderTopicProjectBindingRepository } from '../repositories/founder-topic-project-binding-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { stableId } from './canonical-json.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const lineRoots = { A: 'AiJia AI Native 房产业务', B: '自媒体生产线', C: '公司协作基础设施' } as const;

const topicTargetSchema = z.union([
  z.object({ existingTopicId: text(256) }).strict(),
  z.object({ existingDisplayName: text(200) }).strict(),
  z.object({ create: z.object({ displayName: text(200), stage: topicStageSchema, line: z.enum(['A', 'B', 'C']) }).strict() }).strict()
]);

export const spaceMappingPlanSchema = z.object({
  projects: z.array(z.object({
    projectKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    /** Used only when the project is not registered yet; an existing project row is never edited. */
    displayName: text(200),
    aliases: z.array(text(100)).max(20).default([]),
    page: z.object({ pageId: z.string().trim().regex(/^page_[A-Za-z0-9]+$/), pageUrl: z.string().trim().url(),
      managementMode: z.enum(['space', 'hybrid']).default('hybrid'), syncMode: z.enum(['manual', 'scheduled', 'event']).default('manual') }).strict(),
    topic: topicTargetSchema
  }).strict()).max(50),
  authors: z.array(z.object({ founder: z.enum(['ivy', 'james']), spaceAuthorId: text(256) }).strict()).max(20).default([])
}).strict().superRefine((plan, context) => {
  for (const [index, project] of plan.projects.entries())
    if (!project.page.pageUrl.endsWith(`/${project.page.pageId}`))
      context.addIssue({ code: 'custom', path: ['projects', index, 'page', 'pageUrl'], message: 'pageUrl must end with pageId' });
});
export type SpaceMappingPlan = z.input<typeof spaceMappingPlanSchema>;

export type MappingStep = 'project' | 'page_binding' | 'topic' | 'topic_binding' | 'author';
export interface MappingAction {
  step: MappingStep;
  subject: string;
  status: 'unchanged' | 'will_create' | 'conflict' | 'not_found' | 'ambiguous';
  detail: string;
}
export interface SpaceMappingPreview { ok: boolean; actions: MappingAction[] }

export class SpaceMappingRejectedError extends Error {
  constructor(readonly preview: SpaceMappingPreview) { super('SPACE_MAPPING_REJECTED'); this.name = 'SpaceMappingRejectedError'; }
}

interface Resolved { preview: SpaceMappingPreview; plan: z.output<typeof spaceMappingPlanSchema>;
  topicIds: Map<string, string | { create: { displayName: string; stage: z.infer<typeof topicStageSchema>; line: 'A' | 'B' | 'C' }; rootId: string }> }

/** Read-only: shows exactly what an apply would write, and refuses on any conflict or unresolved target. */
export function previewSpaceMapping(client: Database.Database, rawPlan: unknown): SpaceMappingPreview {
  return resolve(client, rawPlan).preview;
}

function resolve(client: Database.Database, rawPlan: unknown): Resolved {
  const plan = spaceMappingPlanSchema.parse(rawPlan);
  const actions: MappingAction[] = [];
  const push = (action: MappingAction) => actions.push(action);
  const topics = new TopicRepository(client), spaceSync = new SpaceSyncRepository(client);
  const bindings = new FounderTopicProjectBindingRepository(client);
  const canonicalTopics = topics.listCanonicalTopics();
  const byName = (name: string) => canonicalTopics.filter((topic) => topic.displayName.trim() === name.trim());
  const topicIds: Resolved['topicIds'] = new Map();
  for (const project of plan.projects) {
    const key = project.projectKey;
    const existingProject = client.prepare('SELECT display_name FROM projects WHERE project_key = ?').get(key) as { display_name: string } | undefined;
    push(existingProject ? { step: 'project', subject: key, status: 'unchanged', detail: `已登记：${existingProject.display_name}` }
      : { step: 'project', subject: key, status: 'will_create', detail: `新建项目登记：${project.displayName}` });

    const pageBinding = spaceSync.getBindingByPageId(project.page.pageId);
    const projectBinding = spaceSync.getBindingByProjectKey(key);
    if (pageBinding && pageBinding.projectKey !== key) push({ step: 'page_binding', subject: project.page.pageId, status: 'conflict',
      detail: `该页面已绑定到 ${pageBinding.projectKey}` });
    else if (!pageBinding && projectBinding) push({ step: 'page_binding', subject: project.page.pageId, status: 'conflict',
      detail: `${key} 已绑定另一个页面 ${projectBinding.pageId}` });
    else push(pageBinding ? { step: 'page_binding', subject: project.page.pageId, status: 'unchanged', detail: `已绑定 ${key}` }
      : { step: 'page_binding', subject: project.page.pageId, status: 'will_create', detail: `绑定页面 → ${key}（${project.page.managementMode}，${project.page.syncMode}）` });

    let topicId: string | null = null;
    const target = project.topic;
    // Re-running an applied plan: the topic it created is now this project's human-confirmed card.
    const humanCanonical = bindings.getCanonicalBindingForProject(key);
    const registeredCreate = (name: string) => humanCanonical && humanCanonical.source !== 'analysis'
      ? canonicalTopics.find((topic) => topic.id === humanCanonical.topicId && topic.displayName.trim() === name.trim()) : undefined;
    if ('existingTopicId' in target) {
      const topic = canonicalTopics.find((item) => item.id === target.existingTopicId);
      if (topic) { topicId = topic.id; push({ step: 'topic', subject: key, status: 'unchanged', detail: `使用工作地图条目：${topic.displayName}（${topic.id}）` }); }
      else push({ step: 'topic', subject: key, status: 'not_found', detail: `找不到条目 ${target.existingTopicId}` });
    } else if ('existingDisplayName' in target) {
      const matches = byName(target.existingDisplayName);
      if (matches.length === 1) { topicId = matches[0]!.id; push({ step: 'topic', subject: key, status: 'unchanged',
        detail: `使用工作地图条目：${matches[0]!.displayName}（${matches[0]!.id}）` }); }
      else push({ step: 'topic', subject: key, status: matches.length ? 'ambiguous' : 'not_found',
        detail: matches.length ? `“${target.existingDisplayName}”对应 ${matches.length} 个条目，请改用 existingTopicId` : `找不到名为“${target.existingDisplayName}”的条目` });
    } else if (registeredCreate(target.create.displayName)) {
      const topic = registeredCreate(target.create.displayName)!;
      topicId = topic.id; push({ step: 'topic', subject: key, status: 'unchanged', detail: `已登记条目：${topic.displayName}（${topic.id}）` });
    } else {
      const roots = byName(lineRoots[target.create.line]);
      const clash = byName(target.create.displayName);
      if (roots.length !== 1) push({ step: 'topic', subject: key, status: roots.length ? 'ambiguous' : 'not_found',
        detail: `${target.create.line} 线根条目“${lineRoots[target.create.line]}”${roots.length ? '不唯一' : '不存在'}` });
      else if (clash.length) push({ step: 'topic', subject: key, status: 'conflict',
        detail: `已存在同名条目“${target.create.displayName}”（${clash.map((t) => t.id).join('、')}），请改用 existingTopicId` });
      else { topicIds.set(key, { create: target.create, rootId: roots[0]!.id });
        push({ step: 'topic', subject: key, status: 'will_create', detail: `在 ${target.create.line} 线下新建条目：${target.create.displayName}（${target.create.stage}）` }); }
    }
    if (topicId) topicIds.set(key, topicId);

    const canonical = bindings.getCanonicalBindingForProject(key);
    if (canonical && topicId && canonical.topicId === topicId && canonical.source !== 'analysis')
      push({ step: 'topic_binding', subject: key, status: 'unchanged', detail: '已人工确认为该项目的主条目' });
    else if (canonical && canonical.source !== 'analysis' && canonical.topicId !== topicId)
      push({ step: 'topic_binding', subject: key, status: 'conflict', detail: `该项目已人工绑定到另一条目 ${canonical.topicId}` });
    else push({ step: 'topic_binding', subject: key, status: 'will_create', detail: canonical?.source === 'analysis'
      ? `人工确认：项目 → 工作地图主条目（替换机器建议的绑定 ${canonical.topicId}）` : '人工确认：项目 → 工作地图主条目' });
  }
  for (const author of plan.authors) {
    const row = client.prepare("SELECT founder FROM founder_identities WHERE source_system = 'chatgpt_space' AND external_author_id = ?")
      .get(author.spaceAuthorId) as { founder: string } | undefined;
    push(!row ? { step: 'author', subject: author.spaceAuthorId, status: 'will_create', detail: `Space 账号 → ${author.founder}` }
      : row.founder === author.founder ? { step: 'author', subject: author.spaceAuthorId, status: 'unchanged', detail: `已对应 ${row.founder}` }
        : { step: 'author', subject: author.spaceAuthorId, status: 'conflict', detail: `已对应 ${row.founder}，不会改写` });
  }
  return { plan, topicIds, preview: { ok: actions.every((action) => ['unchanged', 'will_create'].includes(action.status)), actions } };
}

/** Writes the previewed plan in one transaction; any conflict rejects the whole plan with nothing written. */
export function applySpaceMapping(client: Database.Database, rawPlan: unknown, input: { changeReference: string; at: Date }): SpaceMappingPreview {
  const changeReference = input.changeReference.trim();
  if (!changeReference) throw new Error('SPACE_MAPPING_CHANGE_REFERENCE_REQUIRED');
  return client.transaction(() => {
    const { plan, preview, topicIds } = resolve(client, rawPlan);
    if (!preview.ok) throw new SpaceMappingRejectedError(preview);
    const at = input.at.toISOString();
    const topics = new TopicRepository(client), spaceSync = new SpaceSyncRepository(client);
    const bindings = new FounderTopicProjectBindingRepository(client);
    for (const project of plan.projects) {
      const target = topicIds.get(project.projectKey)!;
      const stage = typeof target === 'string' ? topics.listCurrentTopics().find((t) => t.id === target)!.stage : target.create.stage;
      client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 'human_confirmed', ?, ?, ?) ON CONFLICT(project_key) DO NOTHING`)
        .run(project.projectKey, project.displayName, JSON.stringify(project.aliases), stage, at, at);
      if (!spaceSync.getBindingByPageId(project.page.pageId)) spaceSync.createBinding({ id: stableId('spacebinding', project.page.pageId),
        projectKey: project.projectKey, spaceId: null, pageId: project.page.pageId, pageUrl: project.page.pageUrl,
        managementMode: project.page.managementMode, syncMode: project.page.syncMode, createdAt: input.at });
      let topicId: string;
      if (typeof target === 'string') topicId = target;
      else {
        const created = topics.createTopic({ displayName: target.create.displayName, stage: target.create.stage, createdAt: input.at,
          rationale: JSON.stringify({ origin: 'space_mapping_registration', changeReference, projectKey: project.projectKey }) });
        topics.addRelation({ fromTopicId: created.id, toTopicId: target.rootId, relationType: 'part_of',
          rationale: `Ivy registered ${project.projectKey} under ${target.create.line} line (${changeReference})`, createdAt: input.at });
        topicId = created.id;
      }
      // A human decision supersedes any machine-proposed canonical row, so exactly one canonical target remains.
      client.prepare(`DELETE FROM founder_topic_project_bindings WHERE project_key = ? AND role = 'canonical'
        AND source = 'analysis' AND topic_id <> ?`).run(project.projectKey, topicId);
      bindings.recordHumanConfirmed({ topicId, projectKey: project.projectKey, role: 'canonical', at: input.at });
    }
    const alignment = new AlignmentRepository(client);
    for (const author of plan.authors) alignment.configureFounderIdentity({ founder: author.founder, sourceSystem: 'chatgpt_space',
      externalAuthorId: author.spaceAuthorId, configuredAt: input.at });
    return preview;
  }).immediate();
}
