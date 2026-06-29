import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Each suite gets its own conf cwd so test runs don't trample each
 * other's config files. Sets SPYCORE_TEST_CWD before importing config.ts
 * — config.ts honours this when constructing the singleton.
 */
export function freshConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spycli-test-'));
  process.env.SPYCORE_TEST_CWD = dir;
  return dir;
}
