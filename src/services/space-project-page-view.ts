import type Database from 'better-sqlite3';
import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { FounderTopicProjectBindingRepository } from '../repositories/founder-topic-project-binding-repository.js';
import { SpaceProjectDigestRepository, type SpaceProjectDigestRecord } from '../repositories/space-project-digest-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { founderText } from './founder-card.js';
import { computeSpaceFreshness, type SpaceFreshnessSummary } from './space-sync-freshness.js';
import { isResolvedSpaceComment } from './space-batch-processor.js';
import { spaceWindowStarts } from './space-page-diff.js';

export interface SpaceProjectPageView {
  freshness: SpaceFreshnessSummary;
  /** Newest stored page snapshot time (the page's own update time), not the sync time. */
  pageUpdatedAt: string | null;
  digest: (Pick<SpaceProjectDigestRecord, 'status' | 'changeBasis' | 'digest' | 'failureCode' | 'generatedAt'> &
    { generatedToday: boolean; generatedThisWeek: boolean }) | null;
  comments: { open: number; resolved: number; ivy: number; james: number; other: number; divergenceCandidates: number };
}

const failureLabels: Record<string, string> = {
  analyzer_unavailable: '摘要服务未启用', codex_auth_required: '本地 Codex 需要重新登录',
  codex_execution_failed: '本地 Codex 执行失败', codex_output_invalid: '模型输出无效',
  space_digest_invalid: '模型输出未通过原文校验'
};

/** Reads stored binding/run/digest/comment state only — never contacts Space itself (handoff doc §8.3). */
export function loadSpaceProjectPageView(client: Database.Database, topicId: string, now: Date,
  staleAfterMinutes: number): SpaceProjectPageView | null {
  const canonical = new FounderTopicProjectBindingRepository(client).listForTopic(topicId)
    .find((row) => row.role === 'canonical' && row.source !== 'analysis');
  if (!canonical) return null;
  const spaceSync = new SpaceSyncRepository(client);
  const binding = spaceSync.getBindingByProjectKey(canonical.projectKey);
  if (!binding) return null;
  const freshness = computeSpaceFreshness({ binding, latestRun: spaceSync.getLatestRunForBinding(binding.id), now, staleAfterMinutes });
  const latestByKey = new Map<string, ReturnType<ContextSourceRepository['listSources']>[number]>();
  for (const source of new ContextSourceRepository(client).listSpacePageSources(binding.pageId)) latestByKey.set(source.logicalKey, source);
  const latest = [...latestByKey.values()];
  const page = latest.find((source) => source.sourceType === 'space_page_snapshot');
  const comments = { open: 0, resolved: 0, ivy: 0, james: 0, other: 0, divergenceCandidates: 0 };
  const founderOf = client.prepare("SELECT founder FROM founder_identities WHERE source_system = 'chatgpt_space' AND external_author_id = ?");
  for (const comment of latest.filter((source) => source.sourceType === 'space_page_comment')) {
    if (isResolvedSpaceComment(spaceSync, comment)) { comments.resolved += 1; continue; }
    comments.open += 1;
    const author = typeof comment.metadata.authorOpenId === 'string' ? comment.metadata.authorOpenId : '';
    const founder = (founderOf.get(author) as { founder: 'ivy' | 'james' } | undefined)?.founder;
    if (founder) comments[founder] += 1; else comments.other += 1;
  }
  const evidenceKind = client.prepare('SELECT locator_json FROM context_evidence WHERE id = ?');
  comments.divergenceCandidates = new AlignmentIssueRepository(client).listForTopic(topicId)
    .filter((issue) => ['candidate', 'ready', 'asked'].includes(issue.status))
    .filter((issue) => issue.evidenceIds.some((id) => {
      const row = evidenceKind.get(id) as { locator_json: string } | undefined;
      return row ? JSON.parse(row.locator_json).kind === 'space_comment' : false;
    })).length;
  const record = new SpaceProjectDigestRepository(client).getLatestForProject(canonical.projectKey);
  const digest = record && (!page || record.pageSourceId === page.id) ? record : record ? { ...record, status: 'failed' as const,
    digest: null, changeBasis: null, failureCode: 'pending_latest_version' } : null;
  // "今日/本周" were computed when the digest was generated; they expire with the founder calendar, not with the page.
  const windows = spaceWindowStarts(now);
  return { freshness, pageUpdatedAt: page?.occurredAt ?? null,
    digest: digest ? { status: digest.status, changeBasis: digest.changeBasis, digest: digest.digest, failureCode: digest.failureCode,
      generatedAt: digest.generatedAt, generatedToday: Date.parse(digest.generatedAt) >= Date.parse(windows.todayStart),
      generatedThisWeek: Date.parse(digest.generatedAt) >= Date.parse(windows.weekStart) } : null,
    comments };
}

/** One compact block per project: page-recorded status, never attributed to a person, never the page rewritten. */
export function renderSpaceProjectPageLines(view: SpaceProjectPageView): string[] {
  const { freshness } = view;
  const synced = freshness.lastSuccessfulSyncAt ? new Date(freshness.lastSuccessfulSyncAt).toISOString() : '尚无成功同步';
  const updated = view.pageUpdatedAt ? new Date(view.pageUpdatedAt).toISOString() : '未知';
  const lines = [`项目页（Space · 页面更新于 ${updated} · 同步于 ${synced}）`];
  if (freshness.status === 'permission_lost') lines.push('Space 权限缺失：以下为最后一次成功同步的历史内容');
  else if (freshness.status === 'stale') lines.push('Space 内容可能滞后，请以最新 Page 为准');
  if (freshness.coverageIncomplete || freshness.gapCount > 0) lines.push(`同步缺口：${freshness.gapCount} 项，未覆盖内容不计入进展`);
  const digest = view.digest;
  if (!digest) lines.push(view.pageUpdatedAt ? '项目页摘要：生成中' : '项目页摘要：尚无页面快照');
  else if (digest.status === 'failed' || !digest.digest) {
    lines.push(digest.failureCode === 'pending_latest_version' ? '项目页摘要：最新版本摘要生成中，暂不展示旧摘要'
      : `项目页摘要未生成（${failureLabels[digest.failureCode ?? ''] ?? '原因未知'}）`);
  } else {
    const d = digest.digest, join = (items: readonly { text: string }[]) => items.map((item) => founderText(item.text, 80)).join('；');
    if (digest.changeBasis === 'first_snapshot') {
      if (d.weekProgress.length) lines.push(`页面记载进展（首次同步，未区分本周）：${join(d.weekProgress)}`);
    } else if (!digest.generatedThisWeek) {
      lines.push(`本周页面无更新${d.weekProgress.length ? `；上次更新的进展（${new Date(digest.generatedAt).toISOString()}）：${join(d.weekProgress)}` : ''}`);
    } else {
      lines.push(`本周进展：${d.weekProgress.length ? join(d.weekProgress) : '本周页面无进展类更新'}`);
      if (d.todayProgress.length && digest.generatedToday) lines.push(`今日：${join(d.todayProgress)}`);
    }
    if (d.currentFocus) lines.push(`当前重点：${founderText(d.currentFocus.text, 80)}`);
    if (d.nextSteps.length) lines.push(`下一步/卡点：${d.nextSteps.map((item) =>
      `${item.kind === 'blocker' ? '卡点' : '下一步'} ${founderText(item.text, 80)}`).join('；')}`);
  }
  const c = view.comments;
  if (c.open || c.resolved) {
    const authors = [['Ivy', c.ivy], ['James', c.james], ['其他', c.other]].filter(([, n]) => n).map(([who, n]) => `${who} ${n}`).join('、');
    lines.push(`Space 评论：未解决 ${c.open} 条${authors ? `（${authors}）` : ''}，已解决 ${c.resolved} 条${c.divergenceCandidates
      ? `；分歧候选 ${c.divergenceCandidates} 项，可发“查看分歧”` : ''}`);
  }
  return lines;
}

/** The overview board's compact form of the same project-page block: one 本周 line and a dated label. */
export function spaceBoardSummary(view: SpaceProjectPageView): { weekLine: string | null; label: string } {
  const freshness = view.freshness;
  const date = view.pageUpdatedAt ? founderMonthDay(view.pageUpdatedAt) : null;
  const label = freshness.status === 'permission_lost' ? 'Space · 权限缺失'
    : `Space · ${date ? `${date} 更新` : '未同步'}${freshness.status === 'stale' ? ' · 可能滞后' : ''}`;
  const digest = view.digest;
  const join = (items: readonly { text: string }[]) => items.map((item) => founderText(item.text, 80)).join('；');
  let weekLine: string | null;
  if (!digest) weekLine = view.pageUpdatedAt ? 'Space 摘要生成中' : null;
  else if (digest.failureCode === 'pending_latest_version') weekLine = 'Space 摘要生成中';
  else if (digest.status === 'failed' || !digest.digest) weekLine = 'Space 摘要未生成';
  else if (digest.changeBasis === 'first_snapshot') weekLine = digest.digest.weekProgress.length ? `页面记载：${join(digest.digest.weekProgress)}` : null;
  else if (!digest.generatedThisWeek) weekLine = '本周：页面无更新';
  else weekLine = `本周：${digest.digest.weekProgress.length ? join(digest.digest.weekProgress) : '页面无进展类更新'}`;
  return { weekLine, label };
}

/** MM-DD on the founder calendar (UTC+8), matching the 今日/本周 windows. */
function founderMonthDay(value: string): string {
  return new Date(Date.parse(value) + 8 * 60 * 60 * 1_000).toISOString().slice(5, 10);
}
