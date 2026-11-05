/**
 * LSP server lifecycle: auto-detection, on-demand start, crash handling, and
 * diagnostics fan-out.
 *
 * Design:
 * - Servers are OPT-IN per project (see config.ts — `./.spycore/lsp.json`).
 *   Without the opt-in nothing is ever spawned.
 * - Servers start ON DEMAND: the first `diagnostics` call for a language
 *   starts its server; it stays up for the process lifetime and is shut down
 *   cleanly at the end (or SIGTERM'd by the process-exit hook if a run ends
 *   without a graceful shutdown — no orphaned servers).
 * - A crashed server degrades to status `error` with the reason recorded; the
 *   next call retries the start once rather than looping forever.
 * - Diagnostics never block the agent loop beyond their bounded wait: every
 *   wait has a timeout, and a server that won't answer yields an empty list
 *   (or a recorded skip), never a hang.
 *
 * The manager is cached per workspace root (`getLspManager`) so repeated tool
 * calls reuse warm servers. `statuses()` returns rows shaped exactly like the
 * Wave-1 sidebar's `LanguageServerInfo`, so the TUI needs no changes.
 */
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  readFileSync,
  type Dirent,
} from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LSP_INIT_TIMEOUT_MS, LspClient } from './client.js';
import { isLspEnabled, loadLspConfig, type LspServerOverride } from './config.js';
import { isWorkspaceTrusted } from '../../config.js';
import {
  LspError,
  type LanguageServerStatus,
  type LspDiagnostic,
  type LspLanguageId,
  type LspServerStatus,
} from './types.js';

/** One built-in server spec: how to find it, start it, and what it handles. */
export interface BuiltinServerSpec {
  language: LspLanguageId;
  /** Display name (sidebar + messages), e.g. 'typescript-language-server'. */
  name: string;
  /** Candidate commands, tried in order until one exists on PATH. */
  candidates: Array<{ command: string; args: string[] }>;
  /** Project-root markers that trigger auto-detection. */
  rootMarkers: string[];
  /** File extensions this server can diagnose (lowercase, with dot). */
  extensions: string[];
  /** Extension → LSP `languageId` for textDocument/didOpen. */
  lspLanguageIds: Record<string, string>;
  /** Human label for the sidebar's `languages` column. */
  languageLabel: string;
}

export const LANGUAGE_SPECS: Record<LspLanguageId, BuiltinServerSpec> = {
  typescript: {
    language: 'typescript',
    name: 'typescript-language-server',
    candidates: [{ command: 'typescript-language-server', args: ['--stdio'] }],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    lspLanguageIds: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    },
    languageLabel: 'TypeScript/JavaScript',
  },
  python: {
    language: 'python',
    name: 'pyright',
    candidates: [
      { command: 'pyright-langserver', args: ['--stdio'] },
      { command: 'pylsp', args: [] },
    ],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    extensions: ['.py'],
    lspLanguageIds: { '.py': 'python' },
    languageLabel: 'Python',
  },
  go: {
    language: 'go',
    name: 'gopls',
    candidates: [{ command: 'gopls', args: [] }],
    rootMarkers: ['go.mod'],
    extensions: ['.go'],
    lspLanguageIds: { '.go': 'go' },
    languageLabel: 'Go',
  },
  rust: {
    language: 'rust',
    name: 'rust-analyzer',
    candidates: [{ command: 'rust-analyzer', args: [] }],
    rootMarkers: ['Cargo.toml'],
    extensions: ['.rs'],
    lspLanguageIds: { '.rs': 'rust' },
    languageLabel: 'Rust',
  },
};

/** Directories never descended into when enumerating workspace files. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  'target',
  '.venv',
  '__pycache__',
  '.hg',
  '.svn',
  'out',
]);

const DEFAULT_FILE_DIAG_TIMEOUT_MS = 20_000;
const DEFAULT_WORKSPACE_DIAG_TIMEOUT_MS = 30_000;
const DEFAULT_WORKSPACE_MAX_FILES = 50;

export interface WorkspaceDiagnostics {
  diagnostics: LspDiagnostic[];
  /** Languages detected but skipped because their server could not start. */
  skipped: Array<{ language: LspLanguageId; reason: string }>;
}

interface ManagedServer {
  spec: BuiltinServerSpec;
  command: string;
  args: string[];
  status: LspServerStatus;
  client: LspClient | null;
  error: string | null;
}

/**
 * Detect languages from project files. Cheap: root markers first, then a
 * single shallow top-level directory listing as a fallback (no deep walk).
 * Returned in spec priority order (typescript, python, go, rust).
 */
export function detectLanguages(cwd: string): LspLanguageId[] {
  const out: LspLanguageId[] = [];
  for (const spec of Object.values(LANGUAGE_SPECS)) {
    if (spec.rootMarkers.some((m) => existsSync(join(cwd, m)))) {
      out.push(spec.language);
      continue;
    }
    try {
      const entries = readdirSync(cwd, { withFileTypes: true });
      if (
        entries.some((e) => e.isFile() && spec.extensions.includes(extname(e.name).toLowerCase()))
      ) {
        out.push(spec.language);
      }
    } catch {
      /* unreadable directory — skip this language */
    }
  }
  return out;
}

/** Which configured language owns a file extension (null when none). */
export function languageForExtension(ext: string): LspLanguageId | null {
  const lower = ext.toLowerCase();
  for (const spec of Object.values(LANGUAGE_SPECS)) {
    if (spec.extensions.includes(lower)) return spec.language;
  }
  return null;
}

/**
 * True when `command` resolves to an executable — an explicit path, or found
 * on PATH (with PATHEXT on Windows). Pure fs probing: no child process, so it
 * stays out of the child-process census.
 */
export function commandExists(command: string): boolean {
  const hasSeparator =
    command.includes('/') || (process.platform === 'win32' && /[\\:]/.test(command));
  if (hasSeparator) {
    try {
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? '';
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, command + ext), fsConstants.X_OK);
        return true;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return false;
}

function resolveServerCommand(
  spec: BuiltinServerSpec,
  override: LspServerOverride | undefined,
): { command: string; args: string[] } {
  if (override) {
    if (!commandExists(override.command)) {
      throw new LspError(
        `LSP server for ${spec.language} not found: configured command "${override.command}" is not on PATH`,
      );
    }
    return { command: override.command, args: override.args ?? spec.candidates[0]?.args ?? [] };
  }
  for (const c of spec.candidates) {
    if (commandExists(c.command)) return { command: c.command, args: c.args };
  }
  const tried = spec.candidates.map((c) => c.command).join(', ');
  throw new LspError(
    `no language server for ${spec.language} found on PATH (tried: ${tried}); install one or override it in .spycore/lsp.json`,
  );
}

/** Bounded recursive file enumeration for one server spec (deterministic order). */
function listCandidateFiles(cwd: string, spec: BuiltinServerSpec, maxFiles: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // isDirectory() is false for symlinks (no d_type follow), so symlinked
        // trees are never descended into — no loop risk.
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.isFile() && spec.extensions.includes(extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(cwd);
  return out;
}

export class LspManager {
  private readonly servers = new Map<LspLanguageId, ManagedServer>();
  /**
   * m3: start-inflight promises. Two concurrent ensureServer() calls for one
   * language must not spawn two servers (the loser would become an orphan,
   * unreachable by shutdown). The second caller awaits the first's start.
   */
  private readonly starting = new Map<LspLanguageId, Promise<LspClient>>();

  constructor(readonly cwd: string) {}

  detectedLanguages(): LspLanguageId[] {
    return detectLanguages(this.cwd);
  }

  /** Whether this manager's project opted into LSP (config.ts). */
  isEnabled(): boolean {
    return isLspEnabled(this.cwd);
  }

  /**
   * Return the running server for `language`, starting it on demand.
   * Throws LspError when no server binary is available or the start fails;
   * the failure is recorded as status `error` with the reason.
   */
  async ensureServer(
    language: LspLanguageId,
    opts?: { initTimeoutMs?: number | undefined },
  ): Promise<LspClient> {
    const existing = this.servers.get(language);
    if (existing?.client && !existing.client.hasExited) return existing.client;
    // m3: if a start is already in flight, await it instead of spawning a
    // second server (which would become an orphan).
    const inflight = this.starting.get(language);
    if (inflight) return inflight;
    const startPromise = this.startServer(language, opts);
    this.starting.set(language, startPromise);
    try {
      return await startPromise;
    } finally {
      this.starting.delete(language);
    }
  }

  private async startServer(
    language: LspLanguageId,
    opts?: { initTimeoutMs?: number | undefined },
  ): Promise<LspClient> {
    const spec = LANGUAGE_SPECS[language];
    // Register BEFORE resolving/starting so a resolution or start failure is
    // still visible as status `error` (the sidebar shows it; the next call
    // retries).
    const managed: ManagedServer = {
      spec,
      command: '',
      args: [],
      status: 'starting',
      client: null,
      error: null,
    };
    this.servers.set(language, managed);
    try {
      // SECURITY: custom server commands from .spycore/lsp.json are only
      // honored in a trusted workspace. In an untrusted workspace (e.g. LSP
      // enabled via SPYCODE_LSP=1 in a cloned repo), fall back to the default
      // command so a malicious config cannot spawn arbitrary processes.
      const override = isWorkspaceTrusted(this.cwd)
        ? loadLspConfig(this.cwd).servers?.[language]
        : undefined;
      const { command, args } = resolveServerCommand(spec, override);
      managed.command = command;
      managed.args = args;
      const client = await LspClient.start({
        command,
        args,
        rootUri: pathToFileURL(this.cwd).href,
        ...(opts?.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        onExit: () => this.onServerExit(language),
      });
      managed.client = client;
      managed.status = 'running';
      return client;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      managed.status = 'error';
      managed.error = message;
      throw err instanceof LspError ? err : new LspError(message);
    }
  }

  /** Sidebar rows for every server this manager has touched. */
  statuses(): LanguageServerStatus[] {
    return [...this.servers.values()].map((m) => ({
      name: m.spec.name,
      status: m.status,
      languages: [m.spec.languageLabel],
    }));
  }

  /** Last recorded start/crash error for a language (null when none). */
  serverError(language: LspLanguageId): string | null {
    return this.servers.get(language)?.error ?? null;
  }

  /**
   * Diagnostics for one file: open it on its language server, wait for the
   * push (bounded), close it again. The server starts on demand.
   */
  async fileDiagnostics(
    absPath: string,
    opts?: { timeoutMs?: number | undefined },
  ): Promise<LspDiagnostic[]> {
    const ext = extname(absPath).toLowerCase();
    const language = languageForExtension(ext);
    if (!language) {
      throw new LspError(
        `no language server configured for "${ext === '' ? '(no extension)' : ext}" files`,
      );
    }
    const client = await this.ensureServer(language);
    const spec = LANGUAGE_SPECS[language];
    const uri = pathToFileURL(absPath).href;
    let text: string;
    try {
      text = readFileSync(absPath, 'utf8');
    } catch {
      throw new LspError(`cannot read "${absPath}"`);
    }
    client.openDocument(uri, spec.lspLanguageIds[ext] ?? language, text);
    try {
      const diags = await client.waitForDiagnostics(uri, opts?.timeoutMs ?? DEFAULT_FILE_DIAG_TIMEOUT_MS);
      // M2: if the server crashed while we waited, the empty result is
      // misleading - surface the recorded crash error instead of reporting
      // a clean file.
      const crashError = this.serverError(language);
      if (diags.length === 0 && crashError) {
        throw new LspError(`language server for ${language} crashed: ${crashError}`);
      }
      return diags;
    } finally {
      client.closeDocument(uri);
    }
  }

  /**
   * Diagnostics across the workspace: for every detected language, start its
   * server, open up to `maxFiles` candidate files, and collect the pushes
   * within the shared `timeoutMs` budget. Languages whose server won't start
   * are reported in `skipped`, never fatal.
   */
  async workspaceDiagnostics(
    opts?: { timeoutMs?: number | undefined; maxFiles?: number | undefined; isSecret?: ((absPath: string) => boolean) | undefined },
  ): Promise<WorkspaceDiagnostics> {
    const budgetMs = opts?.timeoutMs ?? DEFAULT_WORKSPACE_DIAG_TIMEOUT_MS;
    const maxFiles = opts?.maxFiles ?? DEFAULT_WORKSPACE_MAX_FILES;
    const deadline = Date.now() + budgetMs;
    const diagnostics: LspDiagnostic[] = [];
    const skipped: Array<{ language: LspLanguageId; reason: string }> = [];
    for (const language of this.detectedLanguages()) {
      const remaining = deadline - Date.now();
      if (remaining <= 1000) break; // not enough budget left to be useful
      const spec = LANGUAGE_SPECS[language];
      let client: LspClient;
      try {
        client = await this.ensureServer(language, {
          initTimeoutMs: Math.min(remaining, DEFAULT_LSP_INIT_TIMEOUT_MS),
        });
      } catch (err) {
        skipped.push({ language, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const files = listCandidateFiles(this.cwd, spec, maxFiles);
      const uris: string[] = [];
      // m2: skip secret files in workspace mode (single-file mode already
      // guards via the tool layer).
      const isSecret = opts?.isSecret;
      try {
        for (const f of files) {
          if (isSecret?.(f)) continue;
          const ext = extname(f).toLowerCase();
          let text: string;
          try {
            text = readFileSync(f, 'utf8');
          } catch {
            continue; // vanished or unreadable — skip, don't fail the run
          }
          const uri = pathToFileURL(f).href;
          client.openDocument(uri, spec.lspLanguageIds[ext] ?? language, text);
          uris.push(uri);
        }
        // Opens went out first, so pushes arrive concurrently while we wait.
        for (const uri of uris) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          diagnostics.push(...(await client.waitForDiagnostics(uri, Math.min(left, 10_000))));
        }
      } finally {
        for (const uri of uris) client.closeDocument(uri);
      }
    }
    diagnostics.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
    );
    return { diagnostics, skipped };
  }

  /** Graceful shutdown of every managed server (spec order: shutdown→exit). */
  async shutdown(): Promise<void> {
    const clients = [...this.servers.values()]
      .map((m) => m.client)
      .filter((c): c is LspClient => c !== null);
    this.servers.clear();
    for (const client of clients) {
      try {
        await client.shutdown();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Synchronous best-effort kill for the process-exit hook. Never throws. */
  killAllSync(): void {
    for (const m of this.servers.values()) {
      try {
        m.client?.kill();
      } catch {
        /* ignore */
      }
    }
    this.servers.clear();
  }

  /** A server exited on its own (crash): record it, drop the client. */
  private onServerExit(language: LspLanguageId): void {
    const m = this.servers.get(language);
    if (!m) return; // already shut down / cleared
    m.status = 'error';
    m.client = null;
    if (m.error === null) m.error = 'language server exited unexpectedly';
  }
}

// ─────────────────────── process-wide cache ───────────────────────

const managers = new Map<string, LspManager>();
let exitHookRegistered = false;

/**
 * The manager for a workspace root, cached so repeated `diagnostics` calls
 * reuse warm servers. Servers live until `shutdownLspManagers()` or process
 * exit (the exit hook SIGTERMs any stragglers — no orphaned servers).
 */
export function getLspManager(cwd: string): LspManager {
  const key = resolve(cwd);
  let m = managers.get(key);
  if (!m) {
    m = new LspManager(key);
    managers.set(key, m);
    if (!exitHookRegistered) {
      exitHookRegistered = true;
      process.once('exit', () => {
        for (const mm of managers.values()) {
          try {
            mm.killAllSync();
          } catch {
            /* ignore */
          }
        }
      });
    }
  }
  return m;
}

/** Gracefully shut down every cached manager (for run teardown). */
export async function shutdownLspManagers(): Promise<void> {
  const all = [...managers.values()];
  managers.clear();
  for (const m of all) {
    try {
      await m.shutdown();
    } catch {
      /* best-effort */
    }
  }
}

/** Test-only: drop the cache between tests. */
export function __clearLspManagersForTests(): void {
  managers.clear();
}
