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

    this.client.prepare(`
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
    `).run(
      id,
      input.pattern,
      input.patternKind,
      input.projectKey,
      input.subprojectKey,
      input.confidenceHint,
      timestamp,
      timestamp
    );

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
