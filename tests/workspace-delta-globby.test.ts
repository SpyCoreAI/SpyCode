import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fault injection: globby resolves to a module without the export, so every
// globby() call throws and both enumerators take their fail-closed path.
vi.mock('globby', () => ({}));

import {
  diffWorkspace,
  openPause,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from '../src/lib/agent/workspace-delta.js';

describe('workspace-delta without globby', () => {
  test('snapshot, pause census, and diff all fail closed', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'spycli-delta-mock-'));
    try {
      writeFileSync(join(workDir, 'a.txt'), 'a');
      expect(await snapshotWorkspace(workDir)).toBeNull();

      const hand: WorkspaceSnapshot = {
        root: workDir,
        entries: new Map([['a.txt', { sha: 'x', content: 'a' }]]),
        present: new Set(['a.txt']),
      };
      const census = await openPause(hand);
      expect(census.present).toBeNull();

      expect(await diffWorkspace(hand, new Set())).toEqual({ changes: [], uncaptured: [] });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
