import type Database from 'better-sqlite3';
import type { ContextSourceRecord, ContextSourceRepository } from '../repositories/context-source-repository.js';
import type { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { FounderTopicProjectBindingRepository } from '../repositories/founder-topic-project-binding-repository.js';
import type { TopicRepository } from '../repositories/topic-repository.js';
import type { CurrentTopic } from '../domain/topic.js';

const spaceSourceTypes = ['space_page_snapshot', 'space_page_comment'];
const commentExcerptLimit = 1_000;

export interface SpaceBatchSources {
  pages: ContextSourceRecord[];
  comments: ContextSourceRecord[];
}

/**
 * The only work-map topic Space content may touch: a canonical project binding that a
 * human registered (or a configured mapping rule). An analysis-proposed binding is never
 * trusted, so Space can neither create a project card nor pick one by itself.
 */
export function confirmedSpaceProjectTopic(client: Database.Database, topics: TopicRepository,
  projectKey: string): CurrentTopic | null {
  const binding = new FounderTopicProjectBindingRepository(client).getCanonicalBindingForProject(projectKey);
  if (!binding || binding.source === 'analysis') return null;
  return topics.listCurrentTopics().find((topic) => topic.id === binding.topicId) ?? null;
}

/** Admits only Space page/comment sources whose page binding belongs to this projectKey; never a chatId-scoped source. */
export function loadSpaceBatchSources(sources: ContextSourceRepository, spaceSync: SpaceSyncRepository,
  sourceIds: readonly string[], projectKey: string): SpaceBatchSources {
  const loaded: SpaceBatchSources = { pages: [], comments: [] };
  for (const id of sourceIds) {
    const source = sources.getSource(id);
    if (!source || source.contentState !== 'cleartext' || source.availabilityStatus !== 'available' ||
      !spaceSourceTypes.includes(source.sourceType)) throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
    const pageId = source.metadata.pageId;
    const binding = typeof pageId === 'string' ? spaceSync.getBindingByPageId(pageId) : null;
    if (!binding || binding.projectKey !== projectKey) throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
    (source.sourceType === 'space_page_snapshot' ? loaded.pages : loaded.comments).push(source);
  }
  return loaded;
}

/** A comment is evidence verbatim; long bodies are cut to a bounded prefix, which still matches the source text. */
export function spaceCommentExcerpt(comment: ContextSourceRecord): string | null {
  const body = comment.contentText.trim();
  return body ? body.slice(0, commentExcerptLimit).trim() : null;
}

/** The thread's latest observed state wins over the state captured with this (immutable) comment version. */
export function isResolvedSpaceComment(spaceSync: SpaceSyncRepository, comment: ContextSourceRecord): boolean {
  const pageId = comment.metadata.pageId, threadId = comment.metadata.threadId;
  const current = typeof pageId === 'string' && typeof threadId === 'string' ? spaceSync.getCommentThreadState(pageId, threadId) : null;
  return (current ?? comment.metadata.threadState) === 'resolved';
}
