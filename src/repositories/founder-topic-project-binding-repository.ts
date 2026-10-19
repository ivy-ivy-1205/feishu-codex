import type Database from 'better-sqlite3';

export type FounderTopicProjectBindingRole = 'canonical' | 'child' | 'related';
export type FounderTopicProjectBindingSource = 'human_confirmed' | 'mapping_rule' | 'analysis';

export interface FounderTopicProjectBindingRecord {
  topicId: string;
  projectKey: string;
  role: FounderTopicProjectBindingRole;
  source: FounderTopicProjectBindingSource;
  createdAt: string;
  updatedAt: string;
}

export interface RecordFounderTopicProjectBindingInput {
  topicId: string;
  projectKey: string;
  role: FounderTopicProjectBindingRole;
  at: Date;
}

export interface ProposeFounderTopicProjectBindingResult {
  /** false when an existing human_confirmed row for the same (topic, project, role) was left untouched. */
  applied: boolean;
  binding: FounderTopicProjectBindingRecord;
}

/**
 * Analysis may only propose a binding; it must never overwrite a human-confirmed one.
 * See docs/2026-10-19-space-to-context-sync-cloud-code-handoff.md §5.3.
 */
export class FounderTopicProjectBindingRepository {
  constructor(readonly client: Database.Database) {}

  listForTopic(topicId: string): FounderTopicProjectBindingRecord[] {
    return (this.client.prepare('SELECT * FROM founder_topic_project_bindings WHERE topic_id = ? ORDER BY role')
      .all(topicId) as Row[]).map(toRecord);
  }

  listForProject(projectKey: string): FounderTopicProjectBindingRecord[] {
    return (this.client.prepare('SELECT * FROM founder_topic_project_bindings WHERE project_key = ? ORDER BY topic_id, role')
      .all(projectKey) as Row[]).map(toRecord);
  }

  getCanonicalBindingForProject(projectKey: string): FounderTopicProjectBindingRecord | null {
    const row = this.client.prepare(`
      SELECT * FROM founder_topic_project_bindings WHERE project_key = ? AND role = 'canonical'
    `).get(projectKey) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  recordHumanConfirmed(input: RecordFounderTopicProjectBindingInput): FounderTopicProjectBindingRecord {
    return this.upsert({ ...input, source: 'human_confirmed' });
  }

  proposeFromAnalysis(input: RecordFounderTopicProjectBindingInput): ProposeFounderTopicProjectBindingResult {
    const existing = this.get(input.topicId, input.projectKey, input.role);
    if (existing && existing.source === 'human_confirmed') {
      return { applied: false, binding: existing };
    }
    return { applied: true, binding: this.upsert({ ...input, source: 'analysis' }) };
  }

  private get(topicId: string, projectKey: string, role: FounderTopicProjectBindingRole): FounderTopicProjectBindingRecord | null {
    const row = this.client.prepare(`
      SELECT * FROM founder_topic_project_bindings WHERE topic_id = ? AND project_key = ? AND role = ?
    `).get(topicId, projectKey, role) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  private upsert(input: RecordFounderTopicProjectBindingInput & { source: FounderTopicProjectBindingSource }): FounderTopicProjectBindingRecord {
    const timestamp = input.at.toISOString();
    this.client.prepare(`
      INSERT INTO founder_topic_project_bindings (topic_id, project_key, role, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id, project_key, role) DO UPDATE SET
        source = excluded.source, updated_at = excluded.updated_at
    `).run(input.topicId, input.projectKey, input.role, input.source, timestamp, timestamp);
    const record = this.get(input.topicId, input.projectKey, input.role);
    if (!record) throw new Error('founder topic project binding upsert could not be read back');
    return record;
  }
}

interface Row {
  topic_id: string; project_key: string; role: FounderTopicProjectBindingRole;
  source: FounderTopicProjectBindingSource; created_at: string; updated_at: string;
}

function toRecord(row: Row): FounderTopicProjectBindingRecord {
  return {
    topicId: row.topic_id, projectKey: row.project_key, role: row.role,
    source: row.source, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
