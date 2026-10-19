import type { ContextEvidenceRecord } from '../repositories/context-source-repository.js';

export type FounderCardKind = 'founder_work_map' | 'alignment_question' | 'alignment_resolution';
export interface FounderCard { kind: FounderCardKind; card: Record<string, unknown> }
export type FounderCardEvidence = Pick<ContextEvidenceRecord, 'id' | 'sourceId' | 'sourceVersion' | 'excerpt' | 'locator'> & {
  occurredAt: string; minuteToken?: string; isFounderCorrection?: boolean;
};
export const founderSourceExcerptLimit = 240;

/** Display-only projection: never serialize a domain record into a card. */
export function founderText(value: string, limit: number): string {
  const text = value.replace(/ou_[\w-]+/gu, '[身份已隐藏]')
    .replace(/ctxsrc_[\w-]+/gu, '[内部来源已隐藏]')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()
    .replace(/</gu, '＜').replace(/>/gu, '＞');
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
}

export function founderSourceText(source: FounderCardEvidence): string {
  if (!source.id.trim() || !source.sourceId.trim() || !Number.isInteger(source.sourceVersion) || source.sourceVersion < 1 ||
    !Number.isFinite(Date.parse(source.occurredAt)) || !source.excerpt.trim()) throw new Error('valid founder source evidence is required');
  const reference = source.locator.kind === 'group_message'
    ? `群消息 ${founderText(source.locator.messageId, 100)}`
    : source.locator.kind === 'space_page_block'
    ? `Space 页面 ${founderText(source.locator.pageId, 100)} · 第 ${source.locator.blockOrdinal + 1} 块`
    : source.locator.kind === 'space_comment'
    ? `Space 评论 ${founderText(source.locator.messageId, 100)}`
    : `妙记 ${source.minuteToken && /^obcn[A-Za-z0-9_-]{1,100}$/.test(source.minuteToken) ? source.minuteToken : '（外部编号不可用）'} · 第 ${source.locator.segmentOrdinal + 1} 段`;
  return `来源：${reference} · ${new Date(source.occurredAt).toISOString()}\n原文：${founderText(source.excerpt, founderSourceExcerptLimit)}`;
}

export function founderCard(title: string, lines: readonly string[], color = 'blue'): Record<string, unknown> {
  const card = {
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: 'plain_text', content: title } },
    elements: lines.map((content) => ({ tag: 'div', text: { tag: 'plain_text', content } }))
  };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 28_000) throw new Error('founder card exceeds safe payload size');
  return card;
}
