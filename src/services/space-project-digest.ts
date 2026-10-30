import { z } from 'zod';
import { spaceSyncBlockSchema, type SpaceSyncBlock } from '../domain/space-sync.js';
import type { ContextSourceRecord } from '../repositories/context-source-repository.js';
import { spacePageChangeWindows, type SpacePageChangeWindows } from './space-page-diff.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const blockMarkdownLimit = 3_000;
const promptMarkdownBudget = 120_000;

const digestItemSchema = z.object({ text: text(80), blockId: text(256), excerpt: text(400) }).strict();
const nextStepSchema = digestItemSchema.extend({ kind: z.enum(['next', 'blocker']) }).strict();

/**
 * Phases may run in parallel (Ivy's 合伙人对齐室 page, 2026-10-22): several can be in progress at once and at most one is
 * the current focus. `statusText` is the page's own wording for where the phase stands.
 */
const phaseSchema = digestItemSchema.extend({ name: text(30), status: z.enum(['done', 'in_progress', 'upcoming']), statusText: text(60),
  focus: z.boolean() }).strict();

/**
 * The page-level picture behind 查看项目进展: what the project is, its phases as the page divides them, and the page's
 * own completed / in-progress / pending / problems / divergences / open decisions / next plan. Not time-windowed, so it
 * never claims "this week"; every item is grounded in a verbatim excerpt like the rest of the digest.
 * Ivy 2026-10-30: 分歧 and 待决定 list everything the page records; 20 is only a guard against runaway output.
 */
const spaceProjectProfileFields = {
  positioning: digestItemSchema.nullable(),
  phases: z.array(phaseSchema).max(8),
  completed: z.array(digestItemSchema).max(5),
  inProgress: z.array(digestItemSchema).max(3),
  pending: z.array(digestItemSchema).max(3),
  problems: z.array(digestItemSchema).max(3),
  divergences: z.array(digestItemSchema).max(20),
  decisions: z.array(digestItemSchema).max(20),
  nextPlan: z.array(digestItemSchema).max(3)
};
export const spaceProjectProfileSchema = z.object(spaceProjectProfileFields).strict();
/** Profiles stored before 待决定 existed (2026-10-30) are still read; the worker regenerates them once. */
const storedSpaceProjectProfileSchema = z.object({ ...spaceProjectProfileFields, decisions: spaceProjectProfileFields.decisions.optional() }).strict();

const digestFields = {
  currentFocus: digestItemSchema.nullable(),
  weekProgress: z.array(digestItemSchema).max(3),
  todayProgress: z.array(digestItemSchema).max(2),
  nextSteps: z.array(nextStepSchema).max(2)
};
/** Hard caps keep the work map a glance, not a page rewrite: 1 focus, ≤3 week, ≤2 today, ≤2 next/blockers. Every new digest carries a profile. */
export const spaceProjectDigestSchema = z.object({ ...digestFields, profile: spaceProjectProfileSchema }).strict();
/** Digests stored before profiles existed are still read; the worker regenerates them once. */
export const storedSpaceProjectDigestSchema = z.object({ ...digestFields, profile: storedSpaceProjectProfileSchema.optional() }).strict();
export const spaceProjectDigestJsonSchema = z.toJSONSchema(spaceProjectDigestSchema);

export type SpaceProjectDigest = z.infer<typeof spaceProjectDigestSchema>;
export type StoredSpaceProjectDigest = z.infer<typeof storedSpaceProjectDigestSchema>;
export type SpaceProjectProfile = z.infer<typeof spaceProjectProfileSchema>;
export type SpaceDigestItem = z.infer<typeof digestItemSchema>;

export interface SpaceDigestInputBlock { id: string; markdown: string; changedThisWeek: boolean; changedToday: boolean }

export interface SpaceProjectDigestInput {
  projectKey: string;
  projectName: string;
  pageTitle: string;
  pageUpdatedAt: string;
  changeBasis: SpacePageChangeWindows['basis'];
  /** true when long pages were cut to fit the prompt; unchanged blocks are dropped first. */
  truncated: boolean;
  blocks: SpaceDigestInputBlock[];
}

export interface SpaceProjectDigestAnalyzer {
  digest(input: SpaceProjectDigestInput): Promise<SpaceProjectDigest>;
}

export type SpaceDigestValidationReason = 'schema_invalid' | 'unknown_block' | 'excerpt_not_verbatim' |
  'week_item_not_changed_this_week' | 'today_item_not_changed_today' | 'today_without_version_diff' | 'phase_focus_not_unique';

export class SpaceDigestValidationError extends Error {
  readonly code = 'SPACE_DIGEST_OUTPUT_INVALID';
  constructor(readonly reason: SpaceDigestValidationReason) {
    super(`SPACE_DIGEST_OUTPUT_INVALID: ${reason}`);
    this.name = 'SpaceDigestValidationError';
  }
}

export function pageBlocks(source: ContextSourceRecord): SpaceSyncBlock[] {
  return z.array(spaceSyncBlockSchema).parse(source.metadata.blocks ?? []);
}

/** `versions` are every stored snapshot of the same page (same logicalKey), including `page`. */
export function buildSpaceDigestInput(input: { projectKey: string; projectName: string; page: ContextSourceRecord;
  versions: readonly ContextSourceRecord[]; now: Date }): SpaceProjectDigestInput {
  const known = input.versions.filter((version) => version.sourceVersion <= input.page.sourceVersion);
  const windows = spacePageChangeWindows(known.map((version) => ({ occurredAt: version.occurredAt, blocks: pageBlocks(version) })), input.now);
  const week = new Set(windows.weekChangedBlockIds), today = new Set(windows.todayChangedBlockIds);
  const all = pageBlocks(input.page).map((block) => ({ id: block.id, markdown: block.markdown.slice(0, blockMarkdownLimit),
    changedThisWeek: week.has(block.id), changedToday: today.has(block.id) })).filter((block) => block.markdown.trim());
  const keep = new Set<string>();
  let used = 0;
  for (const block of [...all.filter((b) => b.changedThisWeek), ...all.filter((b) => !b.changedThisWeek)]) {
    if (used + block.markdown.length > promptMarkdownBudget) continue;
    keep.add(block.id); used += block.markdown.length;
  }
  return { projectKey: input.projectKey, projectName: input.projectName,
    pageTitle: typeof input.page.metadata.title === 'string' ? input.page.metadata.title : input.projectName,
    pageUpdatedAt: input.page.occurredAt, changeBasis: windows.basis, truncated: keep.size < all.length,
    blocks: all.filter((block) => keep.has(block.id)) };
}

/**
 * Keeps 卡点 / 分歧 / 待决定 from flickering between regenerations (Ivy 2026-10-30). The model draws the line between them
 * a little differently each run, so a paragraph that has not changed since the earlier digest keeps the section it had:
 * an item the model dropped is put back, and one it moved to another section is moved back. A paragraph is "unchanged"
 * when its block id (a content hash) is still on the page and still contains the earlier excerpt. Edited paragraphs are
 * judged afresh. 卡点 keeps its cap of 3; nothing is carried that would break a cap.
 */
export function carryOverSpaceClassifications(next: SpaceProjectDigest, previous: StoredSpaceProjectDigest | null,
  input: SpaceProjectDigestInput): SpaceProjectDigest {
  const before = previous?.profile;
  if (!before) return next;
  const blocks = new Map(input.blocks.map((block) => [block.id, block.markdown]));
  const caps = { divergences: 20, decisions: 20, problems: 3 } as const;
  const names = ['divergences', 'decisions', 'problems'] as const;
  const profile = { ...next.profile, divergences: [...next.profile.divergences], decisions: [...next.profile.decisions],
    problems: [...next.profile.problems] };
  const settled = new Set<string>();
  for (const name of names) {
    for (const old of before[name] ?? []) {
      if (settled.has(old.blockId) || !blocks.get(old.blockId)?.includes(old.excerpt)) continue;
      settled.add(old.blockId);
      const now = names.find((other) => profile[other].some((entry) => entry.blockId === old.blockId));
      if (now === name) continue;
      if (profile[name].length >= caps[name]) continue;
      if (now) profile[now] = profile[now].filter((entry) => entry.blockId !== old.blockId);
      profile[name].push(old);
    }
  }
  return { ...next, profile };
}

/**
 * The last resort after the retries (2026-10-30): an output whose schema and phase plan hold but where a few items fail
 * grounding keeps its grounded items and drops the others, instead of losing the whole digest. A dropped item is never
 * shown (宁缺毋滥); a phase is never dropped, since a missing phase would misstate the plan, so phase failures still fail.
 */
export function pruneUngroundedSpaceDigest(raw: unknown, input: SpaceProjectDigestInput): SpaceProjectDigest {
  const parsed = spaceProjectDigestSchema.safeParse(raw);
  if (!parsed.success) throw new SpaceDigestValidationError('schema_invalid');
  const digest = parsed.data, blocks = new Map(input.blocks.map((block) => [block.id, block]));
  const grounded = (item: SpaceDigestItem) => blocks.get(item.blockId)?.markdown.includes(item.excerpt) ?? false;
  const week = (item: SpaceDigestItem) => grounded(item) && (input.changeBasis !== 'version_diff' || blocks.get(item.blockId)!.changedThisWeek);
  const today = (item: SpaceDigestItem) => grounded(item) && input.changeBasis === 'version_diff' && blocks.get(item.blockId)!.changedToday;
  const { positioning, phases, ...sections } = digest.profile;
  return validateSpaceDigest({ currentFocus: digest.currentFocus && grounded(digest.currentFocus) ? digest.currentFocus : null,
    weekProgress: digest.weekProgress.filter(week), todayProgress: digest.todayProgress.filter(today), nextSteps: digest.nextSteps.filter(grounded),
    profile: { positioning: positioning && grounded(positioning) ? positioning : null, phases,
      ...Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.filter(grounded)])) } }, input);
}

export function validateSpaceDigest(raw: unknown, input: SpaceProjectDigestInput): SpaceProjectDigest {
  const parsed = spaceProjectDigestSchema.safeParse(raw);
  if (!parsed.success) throw new SpaceDigestValidationError('schema_invalid');
  const digest = parsed.data;
  const blocks = new Map(input.blocks.map((block) => [block.id, block]));
  const grounded = (item: SpaceDigestItem) => {
    const block = blocks.get(item.blockId);
    if (!block) throw new SpaceDigestValidationError('unknown_block');
    if (!block.markdown.includes(item.excerpt)) throw new SpaceDigestValidationError('excerpt_not_verbatim');
    return block;
  };
  if (digest.currentFocus) grounded(digest.currentFocus);
  for (const item of digest.nextSteps) grounded(item);
  for (const item of digest.weekProgress) {
    const block = grounded(item);
    if (input.changeBasis === 'version_diff' && !block.changedThisWeek) throw new SpaceDigestValidationError('week_item_not_changed_this_week');
  }
  if (input.changeBasis !== 'version_diff' && digest.todayProgress.length) throw new SpaceDigestValidationError('today_without_version_diff');
  for (const item of digest.todayProgress) {
    if (!grounded(item).changedToday) throw new SpaceDigestValidationError('today_item_not_changed_today');
  }
  const { positioning, phases, ...sections } = digest.profile;
  if (positioning) grounded(positioning);
  for (const item of [...phases, ...Object.values(sections).flat()]) grounded(item);
  if (phases.filter((phase) => phase.focus).length > 1) throw new SpaceDigestValidationError('phase_focus_not_unique');
  return digest;
}
