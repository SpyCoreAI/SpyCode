import { fileURLToPath } from 'node:url';
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

export type InstallMethod =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'volta'
  | 'npx'
  | 'local'
  | 'homebrew'
  | 'scoop'
  | 'unknown';

/**
 * ⭐⭐ THE SIGNAL IS THE CLI'S OWN LOCATION, NOT `process.execPath`.
 *
 * This used to default to `process.execPath` — THE PATH OF THE NODE BINARY —
 * and test the Homebrew arm first. So anyone who ran `npm i -g @spycore/cli`
 * on Homebrew-installed Node was told to run `brew upgrade spycore`, because
 * their NODE lived under `/opt/homebrew`. Measured over eight realistic
 * execPath values, all of them npm-global installs, six got the wrong command
 * and three of those pointed at a Homebrew formula pinned two minors back.
 *
 * ⭐ It was dormant only because 0.6.0 IS the registry `latest`, so `hasUpdate`
 * is false and neither the banner nor `spycore update` ever prints. Publishing
 * anything newer activates it for the entire installed base at once, and no
 * follow-up release can un-notify anyone. That is why it closes BEFORE a
 * publish, not after.
 *
 * ⭐ AND THE POPULATION WAS WRONG TOO. The filed count was eight "install
 * shapes"; those were eight NODE locations for ONE install method. Reading
 * `install.sh` settles it: there is no standalone distribution at all — the
 * curl installer picks `pnpm add -g`, `yarn global add` or `npm install -g`
 * and shells out to it. So the real axis is WHICH PACKAGE MANAGER OWNS THE
 * FILES, and that is answerable from the CLI's own path and from nothing else.
 *
 * Layouts MEASURED on this host by installing the published 0.6.0:
 *   npm -g          <prefix>/lib/node_modules/@spycore/cli/…
 *   project dep     <project>/node_modules/@spycore/cli/…
 *   npx             ~/.npm/_npx/<hash>/node_modules/@spycore/cli/…
 * Layouts encoded from each manager's DOCUMENTED convention, not measured here
 * (no yarn/bun/volta on the measuring host, and the pnpm global install could
 * not be reproduced in an isolated prefix) — stated so the difference is not
 * mistaken for evidence:
 *   pnpm -g, yarn 1 global, bun -g, volta, brew formula, scoop.
 */
export function detectInstallMethod(
  cliPath: string = fileURLToPath(import.meta.url),
): InstallMethod {
  const p = cliPath.replace(/\\/g, '/').toLowerCase();

  // ── owned by a package manager other than npm ──
  if (p.includes('/_npx/')) return 'npx';
  if (p.includes('/.bun/install/global/') || p.includes('/bun/install/global/')) return 'bun';
  if (p.includes('/pnpm/global/') || p.includes('/.pnpm-global/') || p.includes('/pnpm/store/')) return 'pnpm';
  if (p.includes('/yarn/global/') || p.includes('/.yarn/global/')) return 'yarn';
  if (p.includes('/.volta/')) return 'volta';

  // ── owned by a system package manager: keyed on OUR OWN name in the path,
  //    never on the prefix alone. `/opt/homebrew/lib/node_modules/@spycore/cli`
  //    is an NPM install that merely lives under a Homebrew prefix, and reading
  //    the prefix is precisely the defect this replaces.
  //
  //    ⭐ THE TAP AND BUCKET TEMPLATES WERE REMOVED (F-2c-26) AND THESE TWO ARMS
  //    DELIBERATELY STAYED. They are unreachable today rather than wrong: the
  //    `cli-v0.5.0` release carries ZERO assets, no workflow builds any of the
  //    six per-platform archives the templates named, and of the 9 layouts a
  //    shipping install method can produce, 0 detect as homebrew or scoop.
  //    They are kept because if such a layout ever exists — a third-party tap,
  //    or the channel returning with a real build pipeline — `brew upgrade
  //    spycore` is the CORRECT advice for it and `npm install -g` would be
  //    wrong. Deleting them would trade an unreachable branch for a reachable
  //    mistake. See docs/CLI_RELEASE.md for what must exist before either
  //    channel returns. ──
  if (/\/cellar\/spycore\//.test(p)) return 'homebrew';
  if (/\/scoop\/apps\/spycore\//.test(p)) return 'scoop';

  // ── npm: global installs live under a `lib/node_modules` prefix; anything
  //    else under a plain `node_modules` is a project dependency, and telling
  //    that user to install globally would be the wrong advice twice over. ──
  if (p.includes('/lib/node_modules/') || p.includes('/appdata/roaming/npm/node_modules/')) return 'npm';
  if (p.includes('/node_modules/')) return 'local';

  return 'unknown';
}

export function updateCommandFor(method: InstallMethod): string {
  switch (method) {
    case 'homebrew':
      return 'brew upgrade spycore';
    case 'scoop':
      return 'scoop update spycore';
    case 'npm':
      return 'npm install -g @spycore/cli@latest';
    case 'pnpm':
      return 'pnpm add -g @spycore/cli@latest';
    case 'yarn':
      return 'yarn global upgrade @spycore/cli@latest';
    case 'bun':
      return 'bun add -g @spycore/cli@latest';
    case 'volta':
      return 'volta install @spycore/cli@latest';
    case 'npx':
      return 'npx @spycore/cli@latest  (npx has nothing to upgrade — it fetches the version you name)';
    case 'local':
      return 'This is a project dependency, not a global install — update @spycore/cli in this project\'s package.json';
    case 'unknown':
      return 'npm install -g @spycore/cli@latest  (install method not recognised — this is the usual one)';
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
