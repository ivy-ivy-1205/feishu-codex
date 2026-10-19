import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('retention migration image contract', () => {
  it('builds a fail-closed migration-only runtime image', () => {
    const dockerfile = readFileSync(
      new URL('../Dockerfile.retention-migration', import.meta.url),
      'utf8'
    );

    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain(
      'ENTRYPOINT ["node", "dist/cli/migrate-context-source-retention.js"]'
    );
    expect(dockerfile).toContain(
      'org.opencontainers.image.source-commit="${SOURCE_COMMIT}"'
    );
    expect(dockerfile).toContain(
      'ai.aijia.image-purpose="context-source-retention-migration"'
    );

    expect(dockerfile).not.toContain('CMD [');
    expect(dockerfile).not.toContain('EXPOSE');
    expect(dockerfile).not.toContain('@openai/codex');
    expect(dockerfile).not.toContain('dist/server.js');
    expect(dockerfile).not.toContain('COPY --from=build /app/dist ./dist');

    const runtimeCopies = dockerfile.split('\n').filter((line) =>
      line.startsWith('COPY --from=build /app/dist/')
    );
    expect(runtimeCopies).toEqual([
      'COPY --from=build /app/dist/cli/migrate-context-source-retention.js ./dist/cli/',
      'COPY --from=build /app/dist/services/context-source-retention-migration.js ./dist/services/',
      'COPY --from=build /app/dist/db/client.js ./dist/db/',
      'COPY --from=build /app/dist/db/schema.js ./dist/db/'
    ]);
  });
});
