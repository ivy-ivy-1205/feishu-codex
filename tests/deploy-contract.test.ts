import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production deployment contract', () => {
  it('keeps OAuth token key readable inside the container without exposing writable secrets', () => {
    const compose = readFileSync(
      new URL('../deploy/docker-compose.production.yml', import.meta.url),
      'utf8'
    );
    const envExample = readFileSync(
      new URL('../deploy/bridge.env.example', import.meta.url),
      'utf8'
    );

    expect(compose).toContain('mem_limit: 512m');
    expect(compose).toContain('/opt/feishu-codex/secrets:/app/secrets:ro');
    expect(envExample).toContain(
      'FEISHU_OAUTH_TOKEN_KEY_FILE=/app/secrets/feishu-oauth-token-key'
    );
  });

  it('ships the SQLite backup script expected by the production cron', () => {
    const backupScriptUrl = new URL(
      '../deploy/backup-sqlite.sh',
      import.meta.url
    );
    const backupScript = readFileSync(backupScriptUrl, 'utf8');

    expect(backupScript).toContain('/opt/feishu-codex/data/bridge.sqlite');
    expect(backupScript).toContain('/opt/feishu-codex/backups');
    expect(backupScript).toContain(
      'readonly RETAIN_COUNT="${SQLITE_BACKUP_RETAIN_COUNT:-1}"'
    );
    expect(backupScript).toContain(
      'SQLITE_BACKUP_RETAIN_COUNT must be a positive integer'
    );
    expect(backupScript).toContain('chmod 600 "${final_backup}"');
    expect(backupScript).toContain(
      "-name 'bridge-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.sqlite'"
    );
    expect(statSync(backupScriptUrl).mode & 0o111).not.toBe(0);
  });
});
