/**
 * Per-provider BYOK usage tracking.
 *
 * Records token usage from BYOK provider `usage` events to a local JSON file
 * (never sent anywhere). Powers `spycore provider usage`.
 *
 * Storage: `<configDir>/byok-usage.json`
 * Format: { [providerName]: { calls: number, inputTokens: number, outputTokens: number, lastUsed: string } }
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
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

function loadUsage(): ByokUsageMap {
  try {
    const raw = readFileSync(usageFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ByokUsageMap;
    }
    return {};
  } catch {
    return {};
  }
}

function saveUsage(map: ByokUsageMap): void {
  const path = usageFilePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write atomically via temp+rename to avoid corruption on crash.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
  renameSync(tmp, path);
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
    const existing = map[providerName] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastUsed: new Date(0).toISOString(),
    };
    map[providerName] = {
      calls: existing.calls + 1,
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
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
 */
export function isFallbackEligibleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: unknown }).message ?? '').toLowerCase();
  const code = (err as { code?: unknown }).code;
  // HTTP status codes
  if (typeof code === 'number' && [401, 403, 429, 502, 503, 504].includes(code)) return true;
  // Common error patterns
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('authentication') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('network') ||
    msg.includes('timeout')
  );
}
