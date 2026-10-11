/**
 * H-16 - ONE env builder for every child process we spawn.
 *
 * A spawned helper (shell command, hook, MCP server, language server) does
 * not need the user's secrets: stripping them is cheap hardening against a
 * compromised or curious child exfiltrating credentials from its
 * environment. The sensitive-key rule is the same one redact.ts uses for
 * config dumps (`isSecretKey`), so the two stay in agreement by construction.
 *
 * Explicit per-spawn vars (an MCP server's configured `env`, an LSP server's
 * `env`) are layered ON TOP and win: they are deliberate per-server
 * configuration, not ambient inheritance. A key explicitly set to
 * `undefined` removes it.
 *
 * NOT used for `spycore runs` detached re-exec (src/commands/runs.ts): that
 * child IS the CLI, and it needs its own credentials to work.
 */
import { isSecretKey } from './redact.js';

/** Build a child-process env: the current env minus secret-keyed entries, plus explicit overrides. */
export function buildSubprocessEnv(explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSecretKey(key)) continue;
    env[key] = value;
  }
  if (explicit) {
    for (const [key, value] of Object.entries(explicit)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}
