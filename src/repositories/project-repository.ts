import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ProjectDefinition,
  ProjectMappingRule,
  type ProjectConfidence,
  type ProjectMappingRule as ProjectMappingRuleType
} from '../domain/project.js';

export interface RecordIvyCorrectionInput {
  pattern: string;
  patternKind: ProjectMappingRuleType['patternKind'];
  projectKey: string;
  subprojectKey: string | null;
  confidenceHint: ProjectConfidence;
  createdAt: Date;
}

export interface SaveProjectContextSnapshotInput {
  projectKey?: string | null;
  sourceKind: string;
  sourceRef: string;
  content: string;
  capturedAt: Date;
}

export interface RecordMappingConflictInput {
  todoId: string;
  candidateProjectKey: string;
  existingProjectKey: string;
  evidence: string;
  createdAt: Date;
}

export interface ProjectDiagnostics {
  projects: { active: number; archived: number };
  rules: { active: number; ivyCorrections: number };
  contextSnapshots: { total: number; latestCapturedAt: string | null };
  conflicts: { open: number };
}

export class ProjectRepository {
  constructor(readonly client: Database.Database) {}

  listActiveProjects(): ProjectDefinition[] {
    const rows = this.client.prepare(`
      SELECT project_key, display_name, aliases, local_path_hint, repo_url, default_branch, status
      FROM projects
      WHERE status = 'active'
      ORDER BY project_key ASC
    `).all() as ProjectRow[];

    return rows.map(toProjectDefinition);
  }

  listActiveRules(): ProjectMappingRule[] {
    const rows = this.client.prepare(`
      SELECT id, pattern, pattern_kind, project_key, subproject_key, confidence_hint, priority, source, active
      FROM project_mapping_rules
      WHERE active = 1
      ORDER BY priority DESC, id ASC
    `).all() as ProjectRuleRow[];

    return rows.map(toProjectMappingRule);
  }

  recordIvyCorrection(input: RecordIvyCorrectionInput): ProjectMappingRule {
    return this.createCorrectionRule(input);
  }

  createCorrectionRule(input: RecordIvyCorrectionInput): ProjectMappingRule {
    const id = `ivy:${createHash('sha256').update(`${input.pattern}:${input.projectKey}:${input.subprojectKey ?? ''}`).digest('hex').slice(0, 16)}`;
    const timestamp = input.createdAt.toISOString();
    const activeRules = this.client.prepare(`
      SELECT id, pattern
      FROM project_mapping_rules
      WHERE source = 'ivy_correction' AND active = 1 AND pattern_kind = ?
    `);
    const deactivateRule = this.client.prepare(`
      UPDATE project_mapping_rules
      SET active = 0, updated_at = ?
      WHERE id = ?
    `);
    const upsertRule = this.client.prepare(`
      INSERT INTO project_mapping_rules (
        id, pattern, pattern_kind, project_key, subproject_key, confidence_hint,
        priority, source, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1000, 'ivy_correction', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pattern = excluded.pattern,
        pattern_kind = excluded.pattern_kind,
        project_key = excluded.project_key,
        subproject_key = excluded.subproject_key,
        confidence_hint = excluded.confidence_hint,
        priority = excluded.priority,
        source = excluded.source,
        active = excluded.active,
        updated_at = excluded.updated_at
    `);

    this.client.transaction(() => {
      const normalizedPattern = normalizeRulePattern(input.pattern);
      const priorRules = activeRules.all(input.patternKind) as Array<{ id: string; pattern: string }>;
      for (const rule of priorRules) {
        if (rule.id !== id && normalizeRulePattern(rule.pattern) === normalizedPattern) {
          deactivateRule.run(timestamp, rule.id);
        }
      }
      upsertRule.run(
        id,
        input.pattern,
        input.patternKind,
        input.projectKey,
        input.subprojectKey,
        input.confidenceHint,
        timestamp,
        timestamp
      );
    })();

    return ProjectMappingRule.parse({
      id,
      pattern: input.pattern,
      patternKind: input.patternKind,
      projectKey: input.projectKey,
      subprojectKey: input.subprojectKey,
      confidenceHint: input.confidenceHint,
      priority: 1000,
      source: 'ivy_correction',
      active: true
    });
  }

  saveContextSnapshot(input: SaveProjectContextSnapshotInput): void {
    const digest = createHash('sha256').update(input.content).digest('hex');
    const id = `snapshot:${createHash('sha256')
      .update(`${input.projectKey ?? ''}:${input.sourceKind}:${input.sourceRef}:${digest}:${input.capturedAt.toISOString()}`)
      .digest('hex')
      .slice(0, 24)}`;

    this.client.prepare(`
      INSERT INTO project_context_snapshots (
        id, project_key, source_kind, source_ref, content, digest, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      id,
      input.projectKey ?? null,
      input.sourceKind,
      input.sourceRef,
      input.content,
      digest,
      input.capturedAt.toISOString()
    );
  }

  recordMappingConflict(input: RecordMappingConflictInput): void {
    const id = `conflict:${createHash('sha256')
      .update(`${input.todoId}:${input.existingProjectKey}:${input.candidateProjectKey}`)
      .digest('hex')
      .slice(0, 24)}`;

    this.client.prepare(`
      INSERT INTO project_mapping_conflicts (
        id, todo_id, candidate_project_key, existing_project_key, evidence, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `).run(
      id,
      input.todoId,
      input.candidateProjectKey,
      input.existingProjectKey,
      input.evidence,
      input.createdAt.toISOString()
    );
  }

  getDiagnostics(): ProjectDiagnostics {
    const projects = this.client.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived
      FROM projects
    `).get() as CountRow;
    const rules = this.client.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN active = 1 AND source = 'ivy_correction' THEN 1 ELSE 0 END), 0) AS ivy_corrections
      FROM project_mapping_rules
    `).get() as RuleCountRow;
    const contextSnapshots = this.client.prepare(`
      SELECT COUNT(*) AS total, MAX(captured_at) AS latest_captured_at
      FROM project_context_snapshots
    `).get() as SnapshotCountRow;
    const conflicts = this.client.prepare(`
      SELECT COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
      FROM project_mapping_conflicts
    `).get() as ConflictCountRow;

    return {
      projects: { active: projects.active, archived: projects.archived },
      rules: { active: rules.active, ivyCorrections: rules.ivy_corrections },
      contextSnapshots: {
        total: contextSnapshots.total,
        latestCapturedAt: contextSnapshots.latest_captured_at
      },
      conflicts: { open: conflicts.open }
    };
  }
}

function normalizeRulePattern(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

interface CountRow {
  active: number;
  archived: number;
}

interface RuleCountRow {
  active: number;
  ivy_corrections: number;
}

interface SnapshotCountRow {
  total: number;
  latest_captured_at: string | null;
}

interface ConflictCountRow {
  open: number;
}

interface ProjectRow {
  project_key: string;
  display_name: string;
  aliases: string;
  local_path_hint: string | null;
  repo_url: string | null;
  default_branch: string | null;
  status: string;
}

interface ProjectRuleRow {
  id: string;
  pattern: string;
  pattern_kind: string;
  project_key: string;
  subproject_key: string | null;
  confidence_hint: string;
  priority: number;
  source: string;
  active: number;
}

function toProjectDefinition(row: ProjectRow): ProjectDefinition {
  return ProjectDefinition.parse({
    projectKey: row.project_key,
    displayName: row.display_name,
    aliases: JSON.parse(row.aliases),
    localPathHint: row.local_path_hint,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    status: row.status
  });
}

function toProjectMappingRule(row: ProjectRuleRow): ProjectMappingRule {
  return ProjectMappingRule.parse({
    id: row.id,
    pattern: row.pattern,
    patternKind: row.pattern_kind,
    projectKey: row.project_key,
    subprojectKey: row.subproject_key,
    confidenceHint: row.confidence_hint,
    priority: row.priority,
    source: row.source,
    active: row.active === 1
  });
}
