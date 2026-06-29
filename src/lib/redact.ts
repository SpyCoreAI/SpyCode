/**
 * Secret redaction for config output. The CLI's bearer token lives under the
 * `__token__` key in the conf store; a bulk dump (`config list` / `config get`)
 * must never print it. This module deep-clones a value and replaces any
 * secret-keyed field with a fixed placeholder, so JSON / YAML / markdown dumps
 * are all safe by construction.
 */

/** Placeholder substituted for any secret value in dumped output. */
export const REDACTED = '***redacted***';

// Matches obviously-sensitive key names. The explicit `__token__` check in
// isSecretKey is the one that matters today; the pattern future-proofs against
// new secret keys (api keys, passwords, …) ever being added to the store.
const SECRET_KEY_PATTERN = /token|secret|password|apikey|api_key|bearer/i;

/** True if a config key name should have its value redacted in dumped output. */
export function isSecretKey(key: string): boolean {
  return key === '__token__' || SECRET_KEY_PATTERN.test(key);
}

/**
 * Deep-clone `value`, replacing every secret-keyed field (at any depth) with
 * REDACTED. Non-secret values are cloned as-is. The input is never mutated, so
 * the live config store is unaffected.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactSecrets(val);
    }
    return out;
  }
  return value;
}
