import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('local startup contract', () => {
  it('loads the documented .env file before starting the TypeScript server', () => {
    const packageJson = JSON.parse(readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8'
    )) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.dev)
      .toBe('node --env-file=.env --import tsx src/server.ts');
  });

  it('creates only the configured SQLite parent directory when it is absent', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aijia-bridge-startup-'));
    temporaryDirectories.push(temporaryDirectory);
    const filename = join(temporaryDirectory, 'nested', 'data', 'bridge.sqlite');

    const database = createSqliteDatabase(filename);
    database.close();

    expect(statSync(dirname(filename)).isDirectory()).toBe(true);
    expect(statSync(filename).isFile()).toBe(true);
  });

  it('keeps the in-memory SQLite mode compatible', () => {
    const database = createSqliteDatabase(':memory:');

    expect(database.client.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
    database.close();
  });
});
