/**
 * THE secret redactor: the one canonical module that scrubs secret VALUES
 * out of text before it reaches the model or a log. Path GUARDING (whether a
 * file may be opened at all) lives in `lib/agent/secrets.ts`; display
 * SANITIZATION (ANSI/control sequences) lives in `lib/sanitize-display.ts`.
 *
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
 *
 * THIS IS A BACKSTOP, NOT THE WHOLE SCREEN - see `redactConfigDump` below.
 * It keys on the field NAME, which is sufficient only where the names are
 * fixed by an interface. `mcpServers[].headers` is `Record<string, string>`
 * whose names the USER chooses, so no name pattern can enumerate that space.
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

/**
 * F-2c-46 - WHY THE NAME-KEYED PASS ABOVE IS NOT ENOUGH (`C-AC18`).
 *
 * Measured at HEAD by driving the shipped commands: a credential stored under
 * an ordinary-looking name printed in cleartext from `config get --json`,
 * `config list --json` and both `--format` dumps. `Authorization`, `Cookie`,
 * `Proxy-Authorization` and `X-Api-Key` all miss SECRET_KEY_PATTERN, while
 * `X-Auth-Token` happens to hit it - which is the tell that the screen was on
 * the wrong axis rather than merely too small. Header names are user-supplied
 * over `/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/`; a name-keyed screen can never close
 * an unbounded key space, and widening the pattern would only move the line.
 *
 * THE PROPERTY IS ABOUT THE VALUE, NOT THE KEY. The three helpers below
 * screen by what a value IS in the shape that holds it - a URL's userinfo, a
 * templated header value, an environment literal - so a field's NAME stops
 * being load-bearing.
 *
 * THE ORDER IS THE GUARANTEE. `redactConfigDump` runs the name-keyed pass
 * FIRST and the shape pass over its OUTPUT. Every helper maps the placeholder
 * to itself, so nothing the old screen hid can be revealed by the new one: the
 * composition can only ever tighten. That is a property of the order, not an
 * extra branch, and `tests/config-disclosure.test.ts` pins it.
 */

/** `${ENV_VAR}` reference - the one templating form MCP header values accept. */
const ENV_REF_SOURCE = String.raw`\$\{[A-Za-z_][A-Za-z0-9_]*\}`;

/**
 * Redact a value that may embed `${ENV_VAR}` references, PRESERVING the
 * references and replacing every other run of text.
 *
 * THE REFERENCES ARE KEPT ON PURPOSE, AND IT IS A MEASURED DECISION. The
 * secret-safe way to configure an MCP header is `Authorization: Bearer
 * ${MY_TOKEN}` - the secret stays in the environment and only the variable
 * NAME lands on disk. `mcp list` reports such a header as "(from env)" without
 * naming the variable, so blanking the whole value would leave NO command able
 * to answer "which variable does this header read?" - a redactor that hides the
 * field a user needs is a different defect wearing a safer name. A variable
 * name is not a credential, and this repository already prints variable names
 * (`describeEnvVar`, and `expandServerHeaders`' unset-variable error).
 */
export function redactTemplatedValue(raw: string): string {
  // Fresh regex per call: a /g regex carries lastIndex between uses, which is
  // the bug `describeHeader` documents one module over.
  const re = new RegExp(ENV_REF_SOURCE, 'g');
  let out = '';
  let last = 0;
  let found = false;
  for (const m of raw.matchAll(re)) {
    found = true;
    const at = m.index ?? 0;
    if (at > last) out += REDACTED;
    out += m[0];
    last = at + m[0].length;
  }
  if (!found) return REDACTED;
  if (last < raw.length) out += REDACTED;
  return out;
}

/**
 * Remove any credential embedded in a URL's userinfo, keeping the endpoint
 * itself intact - the scheme, host, port and path are what a user debugging a
 * broken server is reading the dump FOR.
 *
 * A URL WITHOUT USERINFO IS RETURNED BYTE-IDENTICAL. `mcp add` and
 * `config set` both refuse credentials in a URL, so every config created
 * through the CLI is untouched by this; only a hand-edited file changes, and it
 * changes from disclosing to not disclosing. Returning `raw` unparsed for that
 * case also avoids URL normalisation quietly rewriting a user's value.
 */
export function redactUrlCredentials(raw: string): string {
  if (!raw.includes('@')) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // not a URL - nothing to strip, and nothing to claim
  }
  if (url.username === '' && url.password === '') return raw;
  url.username = '';
  url.password = '';
  const rest = url.toString();
  const marker = `${url.protocol}//`;
  return rest.startsWith(marker)
    ? `${marker}${REDACTED}@${rest.slice(marker.length)}`
    : rest;
}

/** Shape-aware redaction of one stored MCP server entry. */
function redactMcpServer(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const out = { ...(entry as Record<string, unknown>) };
  if (typeof out.url === 'string') out.url = redactUrlCredentials(out.url);
  if (out.headers !== null && typeof out.headers === 'object' && !Array.isArray(out.headers)) {
    const headers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(out.headers as Record<string, unknown>)) {
      headers[name] = typeof value === 'string' ? redactTemplatedValue(value) : value;
    }
    out.headers = headers;
  }
  if (Array.isArray(out.env)) {
    out.env = out.env.map((e) => {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) return e;
      const v = { ...(e as Record<string, unknown>) };
      // NOT redactTemplatedValue. An env var's stored `value` is handed to
      // the child VERBATIM (`buildMinimalEnv`) - `${…}` is never expanded
      // there. Preserving what looks like a reference would tell the reader it
      // is one. The same-looking text means different things in the two
      // fields, so the two fields do not share a redactor.
      if (typeof v.value === 'string') v.value = REDACTED;
      return v;
    });
  }
  return out;
}

/** Shape-aware redaction of one stored provider entry. */
function redactProvider(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const out = { ...(entry as Record<string, unknown>) };
  if (typeof out.baseURL === 'string') out.baseURL = redactUrlCredentials(out.baseURL);
  return out;
}

/**
 * Free-text secret redaction for transcript export (`/save`).
 *
 * Unlike the config redactors above (which key on field NAMES or SHAPES),
 * conversation content is free text - the only reliable screen is pattern
 * matching on what secret-like VALUES look like. This is intentionally
 * conservative: it redacts patterns that are near-certainly credentials,
 * not every high-entropy string.
 *
 * Covered:
 * - Bearer tokens: `Bearer <token>`
 * - Common API key prefixes: sk-, ghp_, gho_, github_pat_, xox[baprs]-, AKIA
 * - Cloud/vendor key prefixes: ASIA (AWS temp), AIza (Google), glpat-
 *   (GitLab), dop_v1_ (DigitalOcean), SG. (Sendgrid), npm_, pypi_, hf_,
 *   tskey-api- (Tailscale), xai- (xAI), ya29. (Google OAuth), xapp- (Slack)
 * - Labeled secrets: `api_key=...`, `password: ...`, `token="..."` etc.
 * - PEM private keys (full block), PGP private key blocks
 * - JWTs (`eyJ...`), Telegram bot tokens, Discord MFA tokens
 * - URLs with embedded credentials: `https://user:pass@host`
 *
 * Returns the input with matches replaced by REDACTED.
 */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/=]{16,}/g;
const KEY_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|ghs_[A-Za-z0-9]{16,}|ghu_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{50,}|hf_[A-Za-z0-9]{16,}|xox[baprse]-[A-Za-z0-9-]{16,}|xapp-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22,}|tskey-api-[A-Za-z0-9_-]{30,}|xai-[A-Za-z0-9]{32,}|mfa\.[A-Za-z0-9_-]{84}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const LABELED_SECRET_RE =
  /\b(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|password|passwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*(?:"[^"]+"|'[^']+'|`[^`]+`|\S+)/gi;
const PEM_BLOCK_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ED25519 |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ED25519 |ENCRYPTED )?PRIVATE KEY-----/g;
const PGP_BLOCK_RE =
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g;

/**
 * Redact credentials embedded in URLs without regex backtracking (ReDoS-safe).
 * Scans for `://` with indexOf (O(n) total) instead of a greedy scheme regex
 * that backtracks quadratically on large pasted logs.
 */
function redactUrlCredsFreeText(raw: string): string {
  let out = '';
  let last = 0;
  let idx = raw.indexOf('://');
  while (idx !== -1) {
    let s = idx - 1;
    while (s >= 0 && /[a-zA-Z0-9+.-]/.test(raw[s] as string)) s--;
    s++;
    const scheme = raw.slice(s, idx);
    const m = /^([^/\s:@]*):([^/\s@]+)@/.exec(raw.slice(idx + 3));
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme) && m) {
      out += raw.slice(last, s) + scheme + '://' + m[1] + `:${REDACTED}@`;
      last = idx + 3 + (m[0] as string).length;
    }
    idx = raw.indexOf('://', idx + 3);
  }
  return out + raw.slice(last);
}

export function redactFreeText(raw: string): string {
  return redactUrlCredsFreeText(
    raw
      .replace(PGP_BLOCK_RE, REDACTED)
      .replace(PEM_BLOCK_RE, REDACTED)
      .replace(KEY_PREFIX_RE, REDACTED)
      .replace(BEARER_RE, `Bearer ${REDACTED}`)
      .replace(LABELED_SECRET_RE, (m) => m.replace(/[:=]\s*(?:"[^"]+"|'[^']+'|`[^`]+`|\S+)$/, `: ${REDACTED}`)),
  );
}

/**
 * The screen every bulk config dump must use: the name-keyed pass, then the
 * shape pass over its output. `config get` (no key) and `config list` are its
 * only callers; both are pinned by `tests/config-disclosure.test.ts`, which
 * drives the real commands and searches their real stdout.
 */
export function redactConfigDump(value: unknown): unknown {
  const generic = redactSecrets(value);
  if (generic === null || typeof generic !== 'object' || Array.isArray(generic)) return generic;
  const out = { ...(generic as Record<string, unknown>) };
  if (typeof out.apiUrl === 'string') out.apiUrl = redactUrlCredentials(out.apiUrl);
  if (Array.isArray(out.providers)) out.providers = out.providers.map(redactProvider);
  if (Array.isArray(out.mcpServers)) out.mcpServers = out.mcpServers.map(redactMcpServer);
  return out;
}
