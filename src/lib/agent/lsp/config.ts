/**
 * LSP opt-in configuration — per project, off by default.
 *
 * Starting a language server spawns a long-lived child process, so LSP is
 * OPT-IN per project: the project opts in by creating `./.spycore/lsp.json`
 * (mirroring the `./.spycore/mcp.json` project-file pattern) containing
 * `{ "enabled": true }`. The same file can override the command used for any
 * language, e.g. to pin a specific pyright build:
 *
 *   { "enabled": true,
 *     "servers": { "python": { "command": "basedpyright-langserver",
 *                              "args": ["--stdio"] } } }
 *
 * `SPYCODE_LSP=1` / `SPYCODE_LSP=0` overrides the file (and the default) —
 * the escape hatch for CI and tests. Malformed files are ignored (treated as
 * absent), never fatal: a broken JSON file must not break the agent run.
 *
 * Pure file/env reading — no processes spawned, so it stays out of the
 * child-process census.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LspLanguageId } from './types.js';
import { isObject } from '../../text.js';
import { isWorkspaceTrusted } from '../../config.js';

/** Project config file, relative to the workspace root. */
export const LSP_CONFIG_REL = '.spycore/lsp.json';
/** Env var that overrides the file (and the default). */
export const LSP_ENV_VAR = 'SPYCODE_LSP';

export interface LspServerOverride {
  command: string;
  args?: string[] | undefined;
}

export interface LspConfig {
  enabled?: boolean | undefined;
  servers?: Partial<Record<LspLanguageId, LspServerOverride>> | undefined;
}

const LANGUAGE_IDS: ReadonlySet<string> = new Set(['typescript', 'python', 'go', 'rust']);

function parseOverride(raw: unknown): LspServerOverride | null {
  if (!isObject(raw) || typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    return null;
  }
  const override: LspServerOverride = { command: raw.command };
  if (Array.isArray(raw.args)) {
    // Keep the well-formed args and drop only the bad ones: a single
    // non-string arg used to discard the whole array (e.g. `--stdio`),
    // leaving the server to spawn in the wrong mode and hang until the
    // init timeout.
    const args = raw.args.filter((a): a is string => typeof a === 'string');
    if (args.length > 0) override.args = args;
  }
  return override;
}

/** Read and validate the project LSP config. Never throws. */
export function loadLspConfig(cwd: string): LspConfig {
  const path = join(cwd, LSP_CONFIG_REL);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {}; // malformed JSON — ignored, not fatal
  }
  if (!isObject(parsed)) return {};
  const config: LspConfig = {};
  if (typeof parsed.enabled === 'boolean') config.enabled = parsed.enabled;
  if (isObject(parsed.servers)) {
    const servers: Partial<Record<LspLanguageId, LspServerOverride>> = {};
    for (const [key, value] of Object.entries(parsed.servers)) {
      if (!LANGUAGE_IDS.has(key)) continue; // unknown language — ignore
      const override = parseOverride(value);
      if (override) servers[key as LspLanguageId] = override;
    }
    if (Object.keys(servers).length > 0) config.servers = servers;
  }
  return config;
}

/**
 * Whether LSP is enabled for this project. The env var wins over the file;
 * without either, the default is OFF (opt-in).
 */
export function isLspEnabled(cwd: string): boolean {
  const env = process.env[LSP_ENV_VAR];
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
    // Unrecognised value — fall through to the file rather than guessing.
  }
  if (loadLspConfig(cwd).enabled !== true) return false;
  // SECURITY (BLOCKING): the project config file can override server commands
  // (arbitrary process spawn). A cloned repo's .spycore/lsp.json must not
  // execute until the user trusts the workspace - same gate as MCP's
  // resolveTrustedServers. Env-var opt-in (explicit user action) bypasses
  // the ENABLE gate only: it never bypasses the OVERRIDE gate, which lives
  // in exactly one place - `effectiveLspOverrides` below - so a global env
  // var plus an untrusted clone can start the DEFAULT servers but never a
  // repo-supplied command from lsp.json.
  return isWorkspaceTrusted(cwd);
}

/**
 * THE single source of the LSP override trust gate: repo-supplied server
 * commands from `.spycore/lsp.json` apply ONLY in a trusted workspace.
 * Every consumer of overrides - `LspManager.startServer` today, any future
 * override path - must go through this function (or `loadLspConfig` plus
 * this check), never through a second inline trust test. The two checks
 * this replaces (`isLspEnabled`'s env bypass and `startServer`'s re-check)
 * could drift apart; one function cannot disagree with itself.
 */
export function effectiveLspOverrides(
  cwd: string,
): Partial<Record<LspLanguageId, LspServerOverride>> {
  if (!isWorkspaceTrusted(cwd)) return {};
  return loadLspConfig(cwd).servers ?? {};
}
