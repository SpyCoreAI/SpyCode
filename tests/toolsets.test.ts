/**
 * H-5 - toolset surface gates: the inventory covers every registered tool,
 * the filter has disabled+whitelist semantics, and unknown names are
 * ignored rather than failing open.
 */
import { describe, expect, test } from 'vitest';
import {
  TOOLSETS,
  allToolsetTools,
  applyToolsetFilter,
  isKnownToolset,
  resolveDisabledToolsets,
  toolsetOf,
} from '../src/lib/agent/toolsets.js';
import { toolNames } from '../src/lib/agent/tools.js';

describe('TOOLSETS inventory', () => {
  test('every registered tool belongs to exactly one toolset', () => {
    const covered = new Set<string>();
    for (const ts of TOOLSETS) {
      for (const t of ts.tools) {
        expect(covered.has(t), `tool ${t} in two toolsets`).toBe(false);
        covered.add(t);
      }
    }
    const names = toolNames();
    for (const name of names) {
      expect(covered.has(name), `tool ${name} has no toolset`).toBe(true);
    }
    expect(covered.size).toBe(names.length);
    expect(allToolsetTools()).toHaveLength(names.length);
  });

  test('toolsetOf round-trips every tool', () => {
    for (const name of toolNames()) {
      expect(toolsetOf(name).tools).toContain(name);
    }
  });

  test('isKnownToolset accepts only inventory names', () => {
    for (const ts of TOOLSETS) expect(isKnownToolset(ts.name)).toBe(true);
    expect(isKnownToolset('nope')).toBe(false);
    expect(isKnownToolset('')).toBe(false);
  });
});

describe('applyToolsetFilter', () => {
  const all = toolNames();

  test('empty filter is the identity', () => {
    expect(applyToolsetFilter(all, {})).toEqual(all);
  });

  test('disabled toolsets are removed', () => {
    const webTools = TOOLSETS.find((t) => t.name === 'web')!.tools;
    const out = applyToolsetFilter(all, { disabled: ['web'] });
    expect(out).toHaveLength(all.length - webTools.length);
    for (const t of webTools) expect(out).not.toContain(t);
  });

  test('enabled is a whitelist: only the named toolsets survive', () => {
    const out = applyToolsetFilter(all, { enabled: ['files'] });
    expect(out).toEqual(TOOLSETS.find((t) => t.name === 'files')!.tools);
  });

  test('disabled beats enabled (deny wins)', () => {
    expect(applyToolsetFilter(all, { enabled: ['files'], disabled: ['files'] })).toEqual([]);
  });

  test('unknown toolset names are ignored, never fail open', () => {
    expect(applyToolsetFilter(all, { disabled: ['nope'] })).toEqual(all);
    expect(applyToolsetFilter(all, { enabled: ['nope'] })).toEqual([]);
  });

  test('non-inventory names (MCP/extra tools) pass through untouched', () => {
    expect(applyToolsetFilter(['mcp__x__y', ...all], { disabled: ['web'] })).toContain('mcp__x__y');
  });
});

describe('resolveDisabledToolsets', () => {
  test('reads the per-surface list from the raw config value', () => {
    expect(resolveDisabledToolsets({ cli: ['web'], tui: [] }, 'cli')).toEqual(['web']);
    expect(resolveDisabledToolsets({ cli: ['web'], tui: [] }, 'tui')).toEqual([]);
    expect(resolveDisabledToolsets({ cli: ['web'] }, 'acp')).toEqual([]);
  });

  test('malformed shapes degrade to no gating', () => {
    expect(resolveDisabledToolsets(undefined, 'cli')).toEqual([]);
    expect(resolveDisabledToolsets(null, 'cli')).toEqual([]);
    expect(resolveDisabledToolsets([], 'cli')).toEqual([]);
    expect(resolveDisabledToolsets({ cli: 'web' }, 'cli')).toEqual([]);
    expect(resolveDisabledToolsets({ cli: ['web', 42] }, 'cli')).toEqual(['web']);
  });
});
