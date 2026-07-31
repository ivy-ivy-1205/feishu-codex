import type { FastifyInstance } from 'fastify';
import type { ProjectRepository } from '../repositories/project-repository.js';

export function registerProjectDiagnosticsRoute(
  app: FastifyInstance,
  projectRepository: ProjectRepository
): void {
  app.get('/diag/projects', async () => projectRepository.getDiagnostics());
}
