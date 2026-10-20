import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import type { JobRepository } from '../repositories/job-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import type { SpaceSyncIngestRouteDependencies } from '../routes/space-sync.js';

const minimumSecretLength = 32;

/**
 * Server-start wiring for the three Space flags (change sheet 2026-10-20). With every flag off
 * nothing changes: no ingest route, no secret read, and the worker never claims Space jobs.
 */
export function spaceSyncWorkerOptions(config: AppConfig['spaceSync']): {
  spaceAnalysisEnabled: boolean; spaceWorkMapEnabled: boolean; spaceStaleAfterMinutes: number;
} {
  return { spaceAnalysisEnabled: config.analysisEnabled, spaceWorkMapEnabled: config.workmapEnabled,
    spaceStaleAfterMinutes: config.staleAfterMinutes };
}

/** Codex adapters are needed when either Feishu analysis or Space analysis runs. */
export function needsCodexAnalysis(input: { founderAnalysisEnabled: boolean; spaceSync: AppConfig['spaceSync'] }): boolean {
  return input.founderAnalysisEnabled || input.spaceSync.analysisEnabled;
}

/** The signed ingest route's dependencies, or undefined while SPACE_SYNC_INGEST_ENABLED is off. Fails closed on a weak secret. */
export function createSpaceSyncIngestDependencies(input: {
  config: AppConfig['spaceSync']; client: Database.Database; jobRepository: JobRepository; readSecretFile: (path: string) => string;
}): SpaceSyncIngestRouteDependencies | undefined {
  const { config } = input;
  if (!config.ingestEnabled) return undefined;
  const secret = config.hmacSecretFile ? input.readSecretFile(config.hmacSecretFile).trim() : '';
  if (secret.length < minimumSecretLength) throw new Error('SPACE_SYNC_HMAC_SECRET_INVALID');
  return {
    secret, signatureWindowSeconds: config.signatureWindowSeconds, maxBodyBytes: config.maxBodyBytes,
    ingestion: { client: input.client, spaceSyncRepository: new SpaceSyncRepository(input.client),
      contextSourceRepository: new ContextSourceRepository(input.client),
      limits: { maxBlocks: config.maxBlocks, maxComments: config.maxComments },
      jobRepository: input.jobRepository, spaceAnalysisEnabled: config.analysisEnabled }
  };
}
