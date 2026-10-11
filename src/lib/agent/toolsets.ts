/**
 * H-5 - toolsets as surface gates.
 *
 * The flat tool inventory is grouped into named toolsets; each surface
 * (CLI, TUI, ACP) can enable/disable whole toolsets instead of reasoning
 * about individual tools. A toolset is a capability gate, not a promise:
 * `describeToolsForPrompt` / `buildToolDeclarations` withhold disabled
 * toolsets from the catalogue, and `dispatchTool` treats them as unknown
 * tools (defence in depth - a guessed or replayed call is refused too).
 *
 * Semantics of the filter:
 * - `disabled` removes those toolsets.
 * - `enabled` (non-empty) is a whitelist: only those toolsets survive.
 * - Both compose with the existing `readOnlyOnly` / `webEnabled` /
 *   `delegateEnabled` filters in tools.ts - a tool must pass all of them.
 *
 * Unknown toolset names are ignored, never fatal: a hand-edited config
 * naming a toolset from a newer CLI must not break an older one.
 */

/** One named group of tools. */
export interface Toolset {
  /** Stable id used in config (`toolsetsDisabled`) and CLI output. */
  name: string;
  /** One-line human description. */
  description: string;
  /** Registry names of the member tools. */
  tools: string[];
}

/**
 * The toolset inventory. Every registered built-in tool belongs to exactly
 * one toolset - `toolsetOf` throws on an ungrouped name, and the
 * toolset-inventory test pins the 1:1 coverage so a new tool cannot land
 * without a home.
 */
export const TOOLSETS: readonly Toolset[] = [
  {
    name: 'files',
    description: 'Read-only filesystem exploration (read, list, search, map, diagnostics).',
    tools: ['read_file', 'list_dir', 'glob', 'grep', 'repo_map', 'diagnostics'],
  },
  {
    name: 'write',
    description: 'File mutation behind the approval gate (create, overwrite, edit).',
    tools: ['write_file', 'edit_file'],
  },
  {
    name: 'shell',
    description: 'Shell command execution behind the approval gate.',
    tools: ['run_command'],
  },
  {
    name: 'web',
    description: 'Deliberate web access (search, fetch). Read-only.',
    tools: ['web_search', 'fetch_url'],
  },
  {
    name: 'skills',
    description: 'Load installed skill guides into context.',
    tools: ['load_skill'],
  },
  {
    name: 'memory',
    description: 'The agent\'s durable two-file memory (MEMORY.md / USER.md).',
    tools: ['memory'],
  },
  {
    name: 'sessions',
    description: 'Full-text search across past session transcripts.',
    tools: ['session_search'],
  },
  {
    name: 'delegation',
    description: 'Spawn sub-agents for self-contained tasks.',
    tools: ['delegate'],
  },
];

/** The surfaces a toolset gate can target. */
export type ToolsetSurface = 'cli' | 'tui' | 'acp';

/** Look up the toolset that owns a tool name. Throws for an ungrouped name. */
export function toolsetOf(toolName: string): Toolset {
  const found = TOOLSETS.find((ts) => ts.tools.includes(toolName));
  if (!found) throw new Error(`tool "${toolName}" belongs to no toolset`);
  return found;
}

/** Every tool name the inventory covers, in toolset order. */
export function allToolsetTools(): string[] {
  return TOOLSETS.flatMap((ts) => ts.tools);
}

/** True when the name is a known toolset. */
export function isKnownToolset(name: string): boolean {
  return TOOLSETS.some((ts) => ts.name === name);
}

export interface ToolsetFilter {
  /** Toolsets to remove. Unknown names are ignored. */
  disabled?: string[] | undefined;
  /** Non-empty ⇒ whitelist: only these toolsets survive. Unknown names are ignored. */
  enabled?: string[] | undefined;
}

/**
 * Filter a tool-name list through the toolset gate. Pure - pinned by tests.
 * Unknown tool names pass through untouched (extraTools/MCP are not
 * toolset-gated; only the static inventory is).
 */
export function applyToolsetFilter(toolNames: string[], filter: ToolsetFilter): string[] {
  const disabled = new Set((filter.disabled ?? []).filter(isKnownToolset));
  const enabled =
    filter.enabled && filter.enabled.length > 0
      ? new Set(filter.enabled.filter(isKnownToolset))
      : null;
  if (disabled.size === 0 && enabled === null) return toolNames;
  return toolNames.filter((name) => {
    let ts: Toolset;
    try {
      ts = toolsetOf(name);
    } catch {
      return true; // not inventory - MCP/extra tools pass through
    }
    if (disabled.has(ts.name)) return false;
    if (enabled !== null && !enabled.has(ts.name)) return false;
    return true;
  });
}

/**
 * Resolve the effective disabled toolsets for a surface from the raw config
 * value. Non-array / non-string entries are dropped; unknown toolset names
 * are kept (forward-compatible) but have no effect.
 */
export function resolveDisabledToolsets(
  raw: unknown,
  surface: ToolsetSurface,
): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const list = (raw as Record<string, unknown>)[surface];
  if (!Array.isArray(list)) return [];
  return list.filter((n): n is string => typeof n === 'string' && n.length > 0);
}
