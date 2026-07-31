import type Database from 'better-sqlite3';
import { MeetingSummaryDraft, type MeetingTodoDraft } from '../domain/meeting.js';
import type { ProjectConfidence, ProjectMappingStatus } from '../domain/project.js';

export interface MeetingSummaryRecord {
  id: string;
  minuteId: string;
  summaryMessageId: string;
  content: string;
  createdAt: string;
}

export interface MeetingTodoRecord extends MeetingTodoDraft {
  summaryId: string;
  projectKey: string | null;
  subprojectKey: string | null;
  projectConfidence: ProjectConfidence;
  projectEvidence: string;
  projectMappingStatus: ProjectMappingStatus;
  projectPrompt: string;
  createdAt: string;
}

export interface IngestMinuteInput {
  minuteId: string;
  eventId: string;
}

export interface IngestMinuteResult {
  created: boolean;
  minuteId: string;
}

export class MeetingRepository {
  constructor(readonly client: Database.Database) {}

  ingestMinute(
    input: IngestMinuteInput,
    onMinuteCreated?: () => void
  ): IngestMinuteResult {
    const now = new Date().toISOString();
    const ingest = this.client.transaction(() => {
      const event = this.client.prepare(`
        INSERT INTO feishu_events (event_id, minute_id, received_at)
        VALUES (?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(input.eventId, input.minuteId, now);

      if (event.changes === 0) {
        return { created: false, minuteId: input.minuteId };
      }

      const minute = this.client.prepare(`
        INSERT INTO meeting_minutes (minute_id, event_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(minute_id) DO NOTHING
      `).run(input.minuteId, input.eventId, now);

      if (minute.changes === 1) {
        onMinuteCreated?.();
      }

      return {
        created: minute.changes === 1,
        minuteId: input.minuteId
      };
    });

    return ingest();
  }

  saveSummary(input: unknown): MeetingSummaryRecord {
    const draft = MeetingSummaryDraft.parse(input);
    const createdAt = new Date().toISOString();
    const save = this.client.transaction(() => {
      this.client.prepare(`
        INSERT INTO meeting_summaries (id, minute_id, summary_message_id, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(draft.id, draft.minuteId, draft.summaryMessageId, draft.content, createdAt);

      const insertTodo = this.client.prepare(`
        INSERT INTO meeting_todos (
          id, summary_id, displayed_number, title, description, risk, capability, status,
          project_key, subproject_key, project_confidence, project_evidence,
          project_mapping_status, project_prompt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const todo of draft.todos) {
        insertTodo.run(
          todo.id,
          draft.id,
          todo.displayedNumber,
          todo.title,
          todo.description,
          todo.risk,
          todo.capability,
          todo.status,
          todo.projectKey,
          todo.subprojectKey,
          todo.projectConfidence,
          todo.projectEvidence,
          todo.projectMappingStatus,
          todo.projectPrompt,
          createdAt
        );
      }

      return {
        id: draft.id,
        minuteId: draft.minuteId,
        summaryMessageId: draft.summaryMessageId,
        content: draft.content,
        createdAt
      };
    });

    return save();
  }

  findSummaryByMinute(minuteId: string): MeetingSummaryRecord | null {
    const row = this.client.prepare(`
      SELECT id, minute_id, summary_message_id, content, created_at
      FROM meeting_summaries
      WHERE minute_id = ?
    `).get(minuteId) as SummaryRow | undefined;

    return row ? {
      id: row.id,
      minuteId: row.minute_id,
      summaryMessageId: row.summary_message_id,
      content: row.content,
      createdAt: row.created_at
    } : null;
  }

  listTodos(summaryId: string): MeetingTodoRecord[] {
    const rows = this.client.prepare(`
      SELECT id, summary_id, displayed_number, title, description, risk, capability, status,
        project_key, subproject_key, project_confidence, project_evidence, project_mapping_status,
        project_prompt, created_at
      FROM meeting_todos
      WHERE summary_id = ?
      ORDER BY displayed_number ASC
    `).all(summaryId) as TodoRow[];

    return rows.map(toMeetingTodoRecord);
  }

  findTodoByReply(summaryMessageId: string, displayedNumber: number): MeetingTodoRecord | null {
    const row = this.client.prepare(`
      SELECT todos.id, todos.summary_id, todos.displayed_number, todos.title,
        todos.description, todos.risk, todos.capability, todos.status, todos.project_key,
        todos.subproject_key, todos.project_confidence, todos.project_evidence,
        todos.project_mapping_status, todos.project_prompt, todos.created_at
      FROM meeting_todos AS todos
      INNER JOIN meeting_summaries AS summaries ON summaries.id = todos.summary_id
      INNER JOIN outbox ON outbox.idempotency_key = 'minute-summary:' || summaries.minute_id
      WHERE summaries.summary_message_id = ? AND todos.displayed_number = ?
        AND outbox.status = 'delivered' AND outbox.delivered_at IS NOT NULL
    `).get(summaryMessageId, displayedNumber) as TodoRow | undefined;

    return row ? toMeetingTodoRecord(row) : null;
  }

  listTodosByReply(summaryMessageId: string): MeetingTodoRecord[] {
    const rows = this.client.prepare(`
      SELECT todos.id, todos.summary_id, todos.displayed_number, todos.title,
        todos.description, todos.risk, todos.capability, todos.status, todos.project_key,
        todos.subproject_key, todos.project_confidence, todos.project_evidence,
        todos.project_mapping_status, todos.project_prompt, todos.created_at
      FROM meeting_todos AS todos
      INNER JOIN meeting_summaries AS summaries ON summaries.id = todos.summary_id
      INNER JOIN outbox ON outbox.idempotency_key = 'minute-summary:' || summaries.minute_id
      WHERE summaries.summary_message_id = ?
        AND outbox.status = 'delivered' AND outbox.delivered_at IS NOT NULL
      ORDER BY todos.displayed_number ASC
    `).all(summaryMessageId) as TodoRow[];

    return rows.map(toMeetingTodoRecord);
  }

  updateTodoProjectMapping(input: {
    todoId: string;
    projectKey: string | null;
    subprojectKey: string | null;
    projectConfidence: 'high' | 'medium' | 'low';
    projectEvidence: string;
    projectMappingStatus: 'mapped' | 'needs_confirmation' | 'unmapped' | 'dismissed';
    projectPrompt: string;
  }): MeetingTodoRecord | null {
    this.client.prepare(`
      UPDATE meeting_todos
      SET project_key = ?, subproject_key = ?, project_confidence = ?, project_evidence = ?,
        project_mapping_status = ?, project_prompt = ?
      WHERE id = ?
    `).run(
      input.projectKey,
      input.subprojectKey,
      input.projectConfidence,
      input.projectEvidence,
      input.projectMappingStatus,
      input.projectPrompt,
      input.todoId
    );

    const row = this.client.prepare(`
      SELECT id, summary_id, displayed_number, title, description, risk, capability, status,
        project_key, subproject_key, project_confidence, project_evidence, project_mapping_status,
        project_prompt, created_at
      FROM meeting_todos WHERE id = ?
    `).get(input.todoId) as TodoRow | undefined;
    return row ? toMeetingTodoRecord(row) : null;
  }

  dismissTodo(todoId: string): boolean {
    const result = this.client.prepare(`
      UPDATE meeting_todos
      SET project_mapping_status = 'dismissed',
        project_prompt = 'Ivy 已明确表示此项不需要 Codex 推进。'
      WHERE id = ?
    `).run(todoId);
    return result.changes === 1;
  }
}

interface TodoRow {
  id: string;
  summary_id: string;
  displayed_number: number;
  title: string;
  description: string;
  risk: MeetingTodoDraft['risk'];
  capability: MeetingTodoDraft['capability'];
  status: MeetingTodoDraft['status'];
  project_key: string | null;
  subproject_key: string | null;
  project_confidence: ProjectConfidence;
  project_evidence: string;
  project_mapping_status: ProjectMappingStatus;
  project_prompt: string;
  created_at: string;
}

interface SummaryRow {
  id: string;
  minute_id: string;
  summary_message_id: string;
  content: string;
  created_at: string;
}

function toMeetingTodoRecord(row: TodoRow): MeetingTodoRecord {
  return {
    id: row.id,
    summaryId: row.summary_id,
    displayedNumber: row.displayed_number,
    title: row.title,
    description: row.description,
    risk: row.risk,
    capability: row.capability,
    status: row.status,
    projectKey: row.project_key,
    subprojectKey: row.subproject_key,
    projectConfidence: row.project_confidence,
    projectEvidence: row.project_evidence,
    projectMappingStatus: row.project_mapping_status,
    projectPrompt: row.project_prompt,
    createdAt: row.created_at
  };
}
