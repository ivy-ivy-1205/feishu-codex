import type Database from 'better-sqlite3';
import { FounderTopicProjectBindingRepository } from '../repositories/founder-topic-project-binding-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';

export type SpaceManagedVisibilityIneligibleReason =
  | 'not_space_managed'
  | 'no_canonical_binding'
  | 'binding_not_active';

export type SpaceManagedVisibilityReview =
  | { eligible: true }
  | { eligible: false; reason: SpaceManagedVisibilityIneligibleReason };

export type SpaceManagedVisibilityMigrationResult =
  | { status: 'applied' }
  | { status: 'rejected'; reason: SpaceManagedVisibilityIneligibleReason };

interface SpaceManagedVisibilityCheckInput {
  client: Database.Database;
  topicId: string;
  projectKey: string;
}

/**
 * This is the capability, not a production migration: it decides, per topic, whether
 * founder_topic_visibility (who sees it) can be decoupled from project_space_bindings
 * (who maintains it) — see docs/2026-10-19-space-to-context-sync-cloud-code-handoff.md §7.3.
 * Flipping real topics is a separate, human-approved production change, listed per topic
 * in a deployment change sheet; this module never scans or flips rows by name/pattern.
 */
export function reviewSpaceManagedVisibility(input: SpaceManagedVisibilityCheckInput): SpaceManagedVisibilityReview {
  const row = input.client.prepare('SELECT visibility FROM founder_topic_visibility WHERE topic_id = ?')
    .get(input.topicId) as { visibility: string } | undefined;
  if (!row || row.visibility !== 'space_managed') return { eligible: false, reason: 'not_space_managed' };

  const canonical = new FounderTopicProjectBindingRepository(input.client).getCanonicalBindingForProject(input.projectKey);
  if (!canonical || canonical.topicId !== input.topicId) return { eligible: false, reason: 'no_canonical_binding' };

  const binding = new SpaceSyncRepository(input.client).getBindingByProjectKey(input.projectKey);
  if (!binding || binding.status !== 'active') return { eligible: false, reason: 'binding_not_active' };

  return { eligible: true };
}

export function migrateSpaceManagedVisibilityToVisible(input: SpaceManagedVisibilityCheckInput & {
  /** A deployment change-sheet reference (never a Feishu message id for this path); required, never blank. */
  changeReference: string;
  at: Date;
}): SpaceManagedVisibilityMigrationResult {
  if (!input.changeReference.trim()) throw new Error('SPACE_MANAGED_VISIBILITY_CHANGE_REFERENCE_REQUIRED');
  const review = reviewSpaceManagedVisibility(input);
  if (!review.eligible) return { status: 'rejected', reason: review.reason };

  input.client.prepare(`
    UPDATE founder_topic_visibility SET visibility = 'visible', source_message_id = ?, updated_at = ?
    WHERE topic_id = ?
  `).run(input.changeReference.trim(), input.at.toISOString(), input.topicId);
  return { status: 'applied' };
}
