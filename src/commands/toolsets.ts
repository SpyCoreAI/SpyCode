/**
 * H-5 - `spycore toolsets`: list and gate the agent tool inventory by named
 * toolsets, per surface (cli / tui / acp).
 *
 * A toolset is a named group of tools (see src/lib/agent/toolsets.ts).
 * Disabling one for a surface removes its tools from that surface's agent
 * runs entirely - they are withheld from the prompt catalogue AND refused
 * at dispatch (defense in depth). Delegation is special: `delegate` is
 * withheld from leaf children automatically (H-10), never gated here.
 *
 *   spycore toolsets                        list toolsets + per-surface state
 *   spycore toolsets disable web --surface tui
 *   spycore toolsets enable web --surface tui
 */
import { Command, Option } from 'commander';
import { getConfigStore } from '../lib/config.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import { formatOption, json, print, resolveFormat, success } from '../lib/output.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';
import {
  TOOLSETS,
  isKnownToolset,
  resolveDisabledToolsets,
  type ToolsetSurface,
} from '../lib/agent/toolsets.js';

const SURFACES: ToolsetSurface[] = ['cli', 'tui', 'acp'];

function isSurface(s: string): s is ToolsetSurface {
  return (SURFACES as string[]).includes(s);
}

/** The persisted shape: { cli?: string[], tui?: string[], acp?: string[] }. */
function readToolsetsDisabled(): Partial<Record<ToolsetSurface, string[]>> {
  const raw = getConfigStore().get('toolsetsDisabled');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<ToolsetSurface, string[]>> = {};
  for (const s of SURFACES) {
    const list = (raw as Record<string, unknown>)[s];
    if (Array.isArray(list)) out[s] = list.filter((n): n is string => typeof n === 'string');
  }
  return out;
}

function listToolsets(opts: { format?: string }): void {
  const raw = getConfigStore().get('toolsetsDisabled');
  if (resolveFormat(opts.format) === 'json') {
    json({
      toolsets: TOOLSETS.map((ts) => ({
        name: ts.name,
        description: ts.description,
        tools: ts.tools,
        disabledOn: SURFACES.filter((s) => resolveDisabledToolsets(raw, s).includes(ts.name)),
      })),
    });
    return;
  }
  print('Toolsets (disable per surface with `spycore toolsets disable <name> --surface <cli|tui|acp>`):');
  print('');
  for (const ts of TOOLSETS) {
    const disabledOn = SURFACES.filter((s) => resolveDisabledToolsets(raw, s).includes(ts.name));
    print(`  ${ts.name} - ${ts.description}`);
    print(`    tools: ${ts.tools.join(', ')}`);
    print(`    disabled on: ${disabledOn.length > 0 ? disabledOn.join(', ') : '(none)'}`);
  }
}

function setDisabled(name: string, surface: ToolsetSurface, disable: boolean): void {
  const current = readToolsetsDisabled();
  const list = new Set(current[surface] ?? []);
  if (disable) list.add(name);
  else list.delete(name);
  const next: Partial<Record<ToolsetSurface, string[]>> = { ...current };
  if (list.size > 0) next[surface] = [...list].sort();
  else delete next[surface];
  getConfigStore().set('toolsetsDisabled', next);
  success(disable ? `Toolset "${name}" disabled on ${surface}.` : `Toolset "${name}" re-enabled on ${surface}.`);
}

function surfaceOrThrow(raw: string): ToolsetSurface {
  if (!isSurface(raw)) {
    throw new SpycoreCliError(
      `Unknown surface "${sanitizeForDisplay(raw)}".`,
      EXIT_USER_ERROR,
      'Surfaces: cli, tui, acp.',
    );
  }
  return raw;
}

function nameOrThrow(raw: string): string {
  if (!isKnownToolset(raw)) {
    throw new SpycoreCliError(
      `Unknown toolset "${sanitizeForDisplay(raw)}".`,
      EXIT_USER_ERROR,
      `Known toolsets: ${TOOLSETS.map((t) => t.name).join(', ')}`,
    );
  }
  return raw;
}

export function registerToolsetsCommand(program: Command): void {
  const toolsets = program
    .command('toolsets')
    .description('List and gate the agent tool inventory by named toolsets')
    .addOption(formatOption())
    .action((opts: { format?: string }) => listToolsets(opts));

  toolsets
    .command('disable <name>')
    .description('Disable a toolset on one surface')
    .addOption(new Option('--surface <surface>', 'Surface: cli, tui, or acp').makeOptionMandatory())
    .action((name: string, opts: { surface: string }) => {
      setDisabled(nameOrThrow(name), surfaceOrThrow(opts.surface), true);
    });

  toolsets
    .command('enable <name>')
    .description('Re-enable a toolset on one surface')
    .addOption(new Option('--surface <surface>', 'Surface: cli, tui, or acp').makeOptionMandatory())
    .action((name: string, opts: { surface: string }) => {
      setDisabled(nameOrThrow(name), surfaceOrThrow(opts.surface), false);
    });
}
