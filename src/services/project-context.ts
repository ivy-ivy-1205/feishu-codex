import type { ProjectRepository } from '../repositories/project-repository.js';

export interface ProjectContextCard {
  projectKey: string;
  displayName: string;
  aliases: readonly string[];
  summary: string;
  localPathHint: string | null;
  repoUrl: string | null;
}

export interface ProjectContextProvider {
  getProjectCards(): Promise<ProjectContextCard[]>;
}

interface ProjectSnapshotRow {
  project_key: string;
  content: string;
}

/** Provides persisted registry context only; it never reads Mac local paths. */
export class ProjectRepositoryContextProvider implements ProjectContextProvider {
  constructor(private readonly projects: ProjectRepository) {}

  async getProjectCards(): Promise<ProjectContextCard[]> {
    const snapshots = this.projects.client.prepare(`
      SELECT current.project_key, current.content
      FROM project_context_snapshots AS current
      INNER JOIN (
        SELECT project_key, MAX(captured_at) AS captured_at
        FROM project_context_snapshots
        WHERE project_key IS NOT NULL
        GROUP BY project_key
      ) AS newest
        ON newest.project_key = current.project_key
       AND newest.captured_at = current.captured_at
      ORDER BY current.id DESC
    `).all() as ProjectSnapshotRow[];
    const snapshotByProjectKey = new Map<string, string>();
    for (const snapshot of snapshots) {
      if (!snapshotByProjectKey.has(snapshot.project_key)) {
        snapshotByProjectKey.set(snapshot.project_key, snapshot.content);
      }
    }

    return this.projects.listActiveProjects().map((project) => ({
      projectKey: project.projectKey,
      displayName: project.displayName,
      aliases: project.aliases,
      summary: snapshotByProjectKey.get(project.projectKey)
        ?? `${project.displayName}。关键词：${project.aliases.join('、')}。`,
      localPathHint: project.localPathHint,
      repoUrl: project.repoUrl
    }));
  }
}

export class EmptyProjectContextProvider implements ProjectContextProvider {
  async getProjectCards(): Promise<ProjectContextCard[]> {
    return [];
  }
}
