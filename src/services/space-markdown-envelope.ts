import type { SpaceSyncBlock, SpaceSyncEnvelopeV1 } from '../domain/space-sync.js';
import { sha256 } from './canonical-json.js';

/**
 * Manual Space sync from a page Ivy saved as Markdown (change sheet 2026-10-20, D1/C1).
 * A Markdown export carries no block ids, so each blank-line-separated block gets an id
 * derived from its own text; an edited paragraph therefore reads as one block replaced,
 * which is what the this-week/today diff needs. Comments are not in the export, and the
 * envelope says so rather than claiming a complete sync.
 */
export function spaceMarkdownBlocks(markdown: string): SpaceSyncBlock[] {
  const seen = new Map<string, number>();
  return markdown.replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n/u)
    .map((block) => block.replace(/[ \t]+$/gmu, '').replace(/^\n+|\n+$/gu, ''))
    .filter((block) => block.trim())
    .map((block) => {
      const hash = sha256(block), occurrence = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, occurrence);
      return { id: `md_${hash.slice(0, 16)}${occurrence > 1 ? `_${occurrence}` : ''}`, hash, markdown: block };
    });
}

/** "更新于 2026 年 10 月 19 日" at the top of the page, as that day in UTC+8; null when the page does not say. */
export function markdownPageUpdatedAt(markdown: string): string | null {
  const match = /^\s*更新于\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u.exec(markdown);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`;
}

/**
 * `scheduled` is the hourly read by Ivy's local Codex App (change sheet 2026-10-20, T2): the
 * same page text, read through the Pages connector instead of a hand export.
 */
export function buildSpaceMarkdownEnvelope(input: {
  markdown: string; projectKey: string; page: { pageId: string; url: string }; title: string; capturedAt: Date; updatedAt?: string | null;
  trigger?: 'manual' | 'scheduled';
}): SpaceSyncEnvelopeV1 {
  const updatedAt = input.updatedAt ?? markdownPageUpdatedAt(input.markdown);
  const stamp = input.capturedAt.toISOString().replace(/[-:]|\.\d{3}/gu, '');
  const scheduled = input.trigger === 'scheduled';
  return {
    schemaVersion: 1,
    syncId: `${scheduled ? 'auto' : 'md'}-${input.page.pageId}-${stamp}`,
    projectKey: input.projectKey,
    trigger: scheduled ? 'scheduled' : 'manual',
    capturedAt: input.capturedAt.toISOString(),
    page: { pageId: input.page.pageId, spaceId: null, url: input.page.url, title: input.title, sequence: null, updatedAt,
      blocks: spaceMarkdownBlocks(input.markdown) },
    comments: [],
    coverage: { pageComplete: true, commentsComplete: false, nextCursor: null, gaps: [
      { code: 'comments_not_exported', summary: scheduled ? '评论未同步：本次由本机定时读取，只含页面正文。' : '评论未同步：本次由 Markdown 导出，只含页面正文。' },
      ...(updatedAt ? [] : [{ code: 'page_updated_at_unknown', summary: '页面更新时间未知：导出文件里没有写明。' }])
    ] }
  };
}
