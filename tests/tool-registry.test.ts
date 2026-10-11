/**
 * H-6 - tool auto-registration: every tool definition registers itself on
 * import (builtin-tools.ts for the 12 built-ins, durable-memory.ts for
 * `memory`, session-search.ts for `session_search`, delegate.ts for
 * `delegate`), and the registry in tools.ts is DERIVED from those calls. A
 * manual list cannot drift because there is no manual list.
 */
import { describe, expect, test } from 'vitest';
import {
  registeredTools,
  registerTool,
  type ToolDefinition,
} from '../src/lib/agent/tool-core.js';
import { REGISTRY, toolNames } from '../src/lib/agent/tools.js';

const BUILTINS = [
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'repo_map',
  'diagnostics',
  'load_skill',
  'web_search',
  'fetch_url',
  'write_file',
  'edit_file',
  'run_command',
  // H-7 / H-8: the memory + session-search tools register after the
  // built-ins; `delegate` stays last (H-10: leaf runs never see it).
  'memory',
  'session_search',
  'delegate',
];

describe('H-6 tool auto-registration', () => {
  test('the registry holds exactly the 15 tools, in catalogue order', () => {
    expect(toolNames()).toEqual(BUILTINS);
    expect([...REGISTRY.keys()]).toEqual(BUILTINS);
    expect(registeredTools().map((t) => t.name)).toEqual(BUILTINS);
  });

  test('every registered tool has a name, description and JSON args shape', () => {
    for (const t of registeredTools()) {
      expect(t.name.length, 'name').toBeGreaterThan(0);
      expect(t.description.length, 'description').toBeGreaterThan(0);
      expect(t.parameters.type, 'parameters.type').toBe('object');
      expect(typeof t.execute, 'execute').toBe('function');
    }
  });

  test('re-registering a name is a hard error, never a silent shadow', () => {
    const dup: ToolDefinition = {
      name: 'read_file',
      description: 'duplicate',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, summary: '', content: '' }),
    };
    expect(() => registerTool(dup)).toThrow(/duplicate tool registration/);
    // The failed registration did not disturb the registry.
    expect(toolNames()).toEqual(BUILTINS);
  });
});
