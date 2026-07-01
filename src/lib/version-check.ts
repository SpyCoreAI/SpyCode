import { request } from 'undici';
import { getConfigStore } from './config.js';

/**
 * Soft, opt-out background check against the npm registry. We never block
 * a command on the result and we silently swallow every failure — the
 * worst case is the user sees an outdated banner once, not a broken CLI.
 *
 * Cache strategy: 24h. The lookup is cheap, but registry redirects and
 * rate limits make repeating it on every command pointlessly noisy.
 *
 * Disable entirely with SPYCORE_NO_UPDATE_CHECK=1 (also auto-suppressed
 * in CI).
 */
export interface UpdateCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

export interface VersionCheckOptions {
  currentVersion: string;
  packageName?: string;
  registry?: string;
  /** Override TTL in ms — primarily a test hook. */
  cacheTtlMs?: number;
}

const DEFAULT_PACKAGE = '@spycore/cli';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const CACHE_KEY = '__updateCache__';

interface CacheEntry {
  packageName: string;
  latest: string;
  fetchedAt: number;
}

function shouldSkip(): boolean {
  if (process.env.SPYCORE_NO_UPDATE_CHECK === '1') return true;
  if (process.env.CI === 'true') return true;
  return false;
}

function readCache(): CacheEntry | null {
  try {
    const raw = (
      getConfigStore() as unknown as { get(k: string): unknown }
    ).get(CACHE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Partial<CacheEntry>;
    if (
      typeof entry.packageName !== 'string' ||
      typeof entry.latest !== 'string' ||
      typeof entry.fetchedAt !== 'number'
    ) {
      return null;
    }
    return entry as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    (
      getConfigStore() as unknown as { set(k: string, v: unknown): void }
    ).set(CACHE_KEY, entry);
  } catch {
    // best-effort
  }
}

/**
 * Strict semver-major.minor.patch comparison. Treats non-numeric segments
 * (pre-release tags, build metadata) as equal to keep the logic small —
 * worst case we fail to advertise an update, never wrongly advertise one.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const stripPrerelease = (v: string) => v.split('-')[0]?.split('+')[0] ?? v;
  const parse = (v: string): number[] =>
    stripPrerelease(v)
      .split('.')
      .map((n) => Number.parseInt(n, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

export async function checkForUpdates(
  opts: VersionCheckOptions,
): Promise<UpdateCheckResult | null> {
  if (shouldSkip()) return null;

  const packageName = opts.packageName ?? DEFAULT_PACKAGE;
  const registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '');
  const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;

  const cached = readCache();
  if (
    cached &&
    cached.packageName === packageName &&
    Date.now() - cached.fetchedAt < ttl
  ) {
    return {
      current: opts.currentVersion,
      latest: cached.latest,
      hasUpdate: compareVersions(cached.latest, opts.currentVersion) > 0,
    };
  }

  try {
    const url = `${registry}/${encodeURIComponent(packageName).replace('%40', '@')}/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': '@spycore/cli',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const body = (await res.body.json()) as { version?: unknown };
    if (typeof body.version !== 'string' || body.version.length === 0) {
      return null;
    }
    const latest = body.version;
    writeCache({
      packageName,
      latest,
      fetchedAt: Date.now(),
    });
    return {
      current: opts.currentVersion,
      latest,
      hasUpdate: compareVersions(latest, opts.currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

export type InstallMethod = 'npm' | 'homebrew' | 'scoop' | 'standalone';

export function detectInstallMethod(execPath: string = process.execPath): InstallMethod {
  const norm = execPath.replace(/\\/g, '/').toLowerCase();
  if (
    norm.includes('/homebrew/') ||
    norm.includes('/opt/homebrew/') ||
    norm.includes('/usr/local/cellar/')
  ) {
    return 'homebrew';
  }
  if (norm.includes('/scoop/') || norm.includes('\\scoop\\')) {
    return 'scoop';
  }
  if (
    norm.includes('/node_modules/') ||
    norm.includes('/npm/') ||
    norm.includes('appdata/roaming/npm') ||
    norm.includes('/.nvm/') ||
    norm.includes('/.volta/') ||
    norm.includes('/.fnm/')
  ) {
    return 'npm';
  }
  return 'standalone';
}

export function updateCommandFor(method: InstallMethod): string {
  switch (method) {
    case 'homebrew':
      return 'brew upgrade spycore';
    case 'scoop':
      return 'scoop update spycore';
    case 'npm':
      return 'npm install -g @spycore/cli@latest';
    case 'standalone':
      return 'Re-run the installer: curl -fsSL https://spycore.ai/install.sh | sh';
  }
}

/**
 * Test hook: reset the cache so a follow-up call performs a real fetch.
 */
export function __resetUpdateCache(): void {
  try {
    (
      getConfigStore() as unknown as { delete(k: string): void }
    ).delete(CACHE_KEY);
  } catch {
    // ignore
  }
}
