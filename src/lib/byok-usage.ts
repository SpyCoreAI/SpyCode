/**
 * Per-provider BYOK usage tracking.
 *
 * Records token usage from BYOK provider `usage` events to a local JSON file
 * (never sent anywhere). Powers `spycore provider usage`.
 *
 * Storage: `<configDir>/byok-usage.json`
 * Format: { [providerName]: { calls: number, inputTokens: number, outputTokens: number, lastUsed: string } }
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getConfigPath } from './config.js';
import type { Provider } from './providers/types.js';

export interface ByokUsageEntry {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  lastUsed: string; // ISO timestamp
}

export type ByokUsageMap = Record<string, ByokUsageEntry>;

function usageFilePath(): string {
  return join(dirname(getConfigPath()), 'byok-usage.json');
}

/**
 * Validate + sanitize one stored entry. A corrupt file used to flow
 * straight into `recordByokUsage`'s arithmetic, where a string `calls`
 * concatenated (`"3" + 1 === "31"`) and a non-number token count summed
 * to NaN and poisoned every later read. Non-finite numbers become 0 and
 * a non-string timestamp becomes the epoch - the entry survives, the
 * poison does not. Non-object entries are dropped.
 */
function sanitizeEntry(entry: unknown): ByokUsageEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    calls: num(e.calls),
    inputTokens: num(e.inputTokens),
    outputTokens: num(e.outputTokens),
    lastUsed:
      typeof e.lastUsed === 'string' ? e.lastUsed : new Date(0).toISOString(),
  };
}

function loadUsage(): ByokUsageMap {
  try {
    const raw = readFileSync(usageFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: ByokUsageMap = {};
      for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const clean = sanitizeEntry(entry);
        if (clean) out[name] = clean;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function saveUsage(map: ByokUsageMap): void {
  const path = usageFilePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write atomically via temp+rename to avoid corruption on crash. The
  // temp name is unique per process (pid + random): the old fixed
  // `${path}.tmp` let two concurrent CLI processes overwrite each other's
  // in-flight write and corrupt the usage file.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* stale temp is harmless - the rename never happened */
    }
    throw err;
  }
}

/**
 * Record a completed BYOK call. Called when a `usage` event is seen.
 * Never throws - tracking must not break the user's task.
 */
export function recordByokUsage(
  providerName: string,
  inputTokens: number,
  outputTokens: number,
): void {
  try {
    const map = loadUsage();
    // Non-finite token counts (NaN/Infinity from a broken provider event)
    // must not poison the stored sums.
    const inT = Number.isFinite(inputTokens) ? inputTokens : 0;
    const outT = Number.isFinite(outputTokens) ? outputTokens : 0;
    const existing = map[providerName] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastUsed: new Date(0).toISOString(),
    };
    map[providerName] = {
      calls: existing.calls + 1,
      inputTokens: existing.inputTokens + inT,
      outputTokens: existing.outputTokens + outT,
      lastUsed: new Date().toISOString(),
    };
    saveUsage(map);
  } catch {
    // Tracking is best-effort; never break the user's task.
  }
}

/** Read the full usage map (for `provider usage`). */
export function getByokUsage(): ByokUsageMap {
  return loadUsage();
}

/**
 * Wrap a BYOK provider to automatically record `usage` events.
 * The wrapper is transparent - all other behavior is identical.
 */
export function withUsageTracking(provider: Provider, providerName: string): Provider {
  // Preserve prototype methods: spread ({...provider}) loses them for class
  // instances (createConversation, etc. live on the prototype). Use
  // Object.create with the original prototype and property descriptors.
  const wrapped = Object.create(
    Object.getPrototypeOf(provider),
    Object.getOwnPropertyDescriptors(provider),
  ) as Provider;
  const originalStreamChat = provider.streamChat.bind(provider);
  wrapped.streamChat = async function* (params) {
    for await (const ev of originalStreamChat(params)) {
      if (ev.type === 'usage') {
        recordByokUsage(providerName, ev.input, ev.output);
      }
      yield ev;
    }
  };
  return wrapped;
}

/**
 * Check if an error is a fallback-eligible BYOK failure.
 * Eligible: auth errors (401/403), rate limits (429), network errors, timeouts.
 * Not eligible: user errors, invalid requests (these won't succeed on SpyCore either).
 *
 * The matcher works on the error STRINGS the adapters actually emit, not the
 * errno spellings: `connectionErrorMessage` rewrites ECONNREFUSED/ENOTFOUND
 * into prose (`(connection refused)`, `Cannot resolve the model endpoint
 * host`), and probe failures arrive as plain Errors whose message is the
 * adapter's string (`Model endpoint returned HTTP 503.`), so the prose
 * forms and the 5xx substrings are what can ever match here.
 */
export function isFallbackEligibleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: unknown }).message ?? '').toLowerCase();
  const code = (err as { code?: unknown }).code;
  // HTTP status codes
  if (typeof code === 'number' && [401, 403, 408, 429, 502, 503, 504].includes(code)) return true;
  // Common error patterns
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('408') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('rate limit') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_grant') ||
    msg.includes('invalid grant') ||
    msg.includes('authentication') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    // Mid-stream errnos outside the connect-time set: a DNS failure or a
    // broken pipe mid-stream arrives as `Model stream interrupted:
    // getaddrinfo EAI_AGAIN …`, which never flows through
    // `connectionErrorMessage`'s prose - so the errno spellings are what
    // can ever match here (R2-5).
    msg.includes('eai_again') ||
    msg.includes('ehostunreach') ||
    msg.includes('enetunreach') ||
    msg.includes('epipe') ||
    // Prose forms `connectionErrorMessage` actually emits for the errno
    // spellings above - the spellings themselves never survive into the
    // probe error string.
    msg.includes('connection refused') ||
    msg.includes('cannot resolve') ||
    msg.includes('cannot reach') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    // The probe throws 'BYOK provider probe timed out after 15s' - "timed
    // out" does not contain "timeout", so probe timeouts were rethrown as
    // hard errors instead of falling back to SpyCore.
    msg.includes('timed out')
  );
}
