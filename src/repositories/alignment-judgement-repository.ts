import type Database from 'better-sqlite3';
import { stableId } from '../services/canonical-json.js';

export type AlignmentJudgementItemKind = 'alignment_issue' | 'space_item';
export type AlignmentJudgementSection = 'divergence' | 'decision';
export type AlignmentJudgementVerdict = 'resolved' | 'not_divergence';

export interface AlignmentJudgement {
  itemKind: AlignmentJudgementItemKind;
  itemKey: string;
  topicId: string;
  projectName: string;
  itemText: string;
  section: AlignmentJudgementSection;
  verdict: AlignmentJudgementVerdict;
  statement: string | null;
  founder: 'ivy' | 'james';
  createdAt: string;
}

/**
 * A Space item is judged by its paragraph: block ids are content hashes, so the judgement holds while the paragraph
 * stays as written and lapses when the page rewrites it (the page then says something new).
 */
export function spaceJudgementKey(projectKey: string, blockId: string): string { return `${projectKey}:${blockId}`; }

/**
 * 查看分歧 replies (Ivy 2026-10-30): one founder's 已解决 or 不是分歧 settles an item. Each item is judged once; the
 * reply itself is stored as evidence, so the original divergence and who closed it stay traceable.
 */
export class AlignmentJudgementRepository {
  constructor(readonly client: Database.Database) {}

  record(input: AlignmentJudgement & { chatId: string; evidenceId: string; sourceMessageId: string; bindingMessageId: string }): boolean {
    return this.client.prepare(`INSERT INTO founder_alignment_judgements (id, chat_id, item_kind, item_key, topic_id, project_name,
      item_text, section, verdict, statement, founder, evidence_id, source_message_id, binding_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_kind, item_key) DO NOTHING`)
      .run(stableId('alignmentjudgement', `${input.itemKind}\n${input.itemKey}`), input.chatId, input.itemKind, input.itemKey,
        input.topicId, input.projectName, input.itemText, input.section, input.verdict, input.statement, input.founder,
        input.evidenceId, input.sourceMessageId, input.bindingMessageId, input.createdAt).changes === 1;
  }

  isJudged(itemKind: AlignmentJudgementItemKind, itemKey: string): boolean {
    return Boolean(this.client.prepare('SELECT 1 FROM founder_alignment_judgements WHERE item_kind = ? AND item_key = ?').get(itemKind, itemKey));
  }

  judgedSpaceBlockIds(projectKey: string): Set<string> {
    const prefix = spaceJudgementKey(projectKey, '');
    return new Set((this.client.prepare(`SELECT item_key FROM founder_alignment_judgements
      WHERE item_kind = 'space_item' AND substr(item_key, 1, ?) = ?`).all(prefix.length, prefix) as { item_key: string }[])
      .map((row) => row.item_key.slice(prefix.length)));
  }

  /** Newest first: what was settled as resolved since `since`, for 查看分歧's 最近已解决. */
  listResolvedSince(since: string): AlignmentJudgement[] {
    return (this.client.prepare(`SELECT * FROM founder_alignment_judgements WHERE verdict = 'resolved' AND created_at >= ?
      ORDER BY created_at DESC, id`).all(since) as Row[]).map((row) => ({ itemKind: row.item_kind, itemKey: row.item_key,
      topicId: row.topic_id, projectName: row.project_name, itemText: row.item_text, section: row.section, verdict: row.verdict,
      statement: row.statement, founder: row.founder, createdAt: row.created_at }));
  }
}

interface Row {
  item_kind: AlignmentJudgementItemKind; item_key: string; topic_id: string; project_name: string; item_text: string;
  section: AlignmentJudgementSection; verdict: AlignmentJudgementVerdict; statement: string | null; founder: 'ivy' | 'james';
  created_at: string;
}
