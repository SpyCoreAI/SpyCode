import { request } from 'undici';
import { getToken } from './auth.js';
import { isTrustedTokenHost, normalizeApiBase, resolveApiUrl } from './config.js';
import {
  EXIT_AUTH_ERROR,
  EXIT_NETWORK_ERROR,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
} from './errors.js';

export interface ApiOptions {
  /** Override of the resolved api URL — usually just the parsed `--api-url` flag value. */
  apiUrlOverride?: string | undefined;
  /** Skip the Authorization header even if a token is stored. Used by the public login route. */
  anonymous?: boolean;
  /** Body for POST/PUT/DELETE; serialised as JSON. */
  body?: unknown;
  /** Extra headers to merge with defaults. */
  headers?: Record<string, string>;
  /** ms — defaults to 30s. */
  timeoutMs?: number;
}

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiFailure {
  success: false;
  error?: string;
  message?: string;
  code?: string;
}

type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = '@spycore/cli';

/**
 * Thin JSON wrapper around undici. Maps every error to a SpycoreCliError
 * with an exit code so the top-level `fail()` can render it consistently.
 *
 * Status code → exit code map:
 *   401          → EXIT_AUTH_ERROR (suggests `spycore login`)
 *   403          → EXIT_AUTH_ERROR (permission denied — different hint)
 *   404, 4xx     → EXIT_USER_ERROR
 *   429          → EXIT_NETWORK_ERROR (rate limited — surface retry-after)
 *   5xx          → EXIT_SERVER_ERROR
 *   network/abort → EXIT_NETWORK_ERROR
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const base = normalizeApiBase(resolveApiUrl(opts.apiUrlOverride));
  // `base` is guaranteed to end in exactly one `/api` (normalizeApiBase).
  // Some call sites also prefix their path with `/api/` — strip the redundant
  // segment so the URL never doubles up (`…/api/api/memory`). Both `/api/x`
  // and `/x` path forms resolve.
  let rel = path.startsWith('/') ? path : `/${path}`;
  if (rel.startsWith('/api/')) rel = rel.slice(4);
  const url = `${base}${rel}`;

  const headers: Record<string, string> = {
    'user-agent': DEFAULT_USER_AGENT,
    accept: 'application/json',
    ...opts.headers,
  };

  // Attach the bearer token ONLY to trusted SpyCore hosts (+ localhost for dev).
  // A user who repoints --api-url / SPYCORE_API_URL at any other host gets no
  // Authorization header, so the token can't be exfiltrated to an attacker- or
  // prompt-injected base URL. Self-hosting/dev still works via localhost.
  if (!opts.anonymous && isTrustedTokenHost(url)) {
    const token = await getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res;
  try {
    res = await request(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    const causeCode = extractErrnoCode(err);
    if (controller.signal.aborted) {
      throw new SpycoreCliError(
        `Request timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
        EXIT_NETWORK_ERROR,
        'Check your connection or try --api-url to point at a reachable endpoint.',
      );
    }
    if (causeCode === 'ENOTFOUND') {
      throw new SpycoreCliError(
        `Cannot resolve API hostname: ${message}`,
        EXIT_NETWORK_ERROR,
        `Tried ${url}. Check your DNS / internet connection.`,
      );
    }
    if (causeCode === 'ECONNREFUSED') {
      throw new SpycoreCliError(
        `Connection refused: ${message}`,
        EXIT_NETWORK_ERROR,
        `Tried ${url}. The endpoint is unreachable — wrong port or service is down.`,
      );
    }
    if (causeCode === 'CERT_HAS_EXPIRED' || causeCode?.startsWith('UNABLE_TO_VERIFY')) {
      throw new SpycoreCliError(
        `TLS error: ${message}`,
        EXIT_NETWORK_ERROR,
        'The API certificate failed verification. Are you behind a corporate MITM proxy?',
      );
    }
    throw new SpycoreCliError(
      `Cannot reach API: ${message}`,
      EXIT_NETWORK_ERROR,
      `Tried ${url}. Check your connection or run \`spycore config get apiUrl\`.`,
    );
  }
  clearTimeout(timeout);

  const status = res.statusCode;
  let parsed: ApiResponse<T> | null = null;
  try {
    parsed = (await res.body.json()) as ApiResponse<T>;
  } catch {
    // Body wasn't JSON — fall through to the status-code branch below.
  }

  if (status >= 200 && status < 300 && parsed && parsed.success) {
    return parsed.data;
  }

  const errMsg =
    (parsed && !parsed.success && (parsed.error || parsed.message)) ||
    `HTTP ${status}`;

  if (status === 401) {
    throw new SpycoreCliError(
      `Authentication failed: ${errMsg}`,
      EXIT_AUTH_ERROR,
      "Run `spycore login` to re-authenticate.",
    );
  }
  if (status === 403) {
    throw new SpycoreCliError(
      `Permission denied: ${errMsg}`,
      EXIT_AUTH_ERROR,
      'This action may require a higher plan or a different account.',
    );
  }
  if (status === 429) {
    const retryAfter = res.headers['retry-after'];
    const hint =
      typeof retryAfter === 'string' && retryAfter.length > 0
        ? `Retry after ${retryAfter}s.`
        : 'Wait a moment and try again.';
    throw new SpycoreCliError(
      `Rate limit exceeded: ${errMsg}`,
      EXIT_NETWORK_ERROR,
      hint,
    );
  }
  if (status >= 500) {
    throw new SpycoreCliError(
      `Server error: ${errMsg}`,
      EXIT_SERVER_ERROR,
      'The SpyCore API is having trouble. Try again in a moment.',
    );
  }
  if (status === 404) {
    // Best-effort hint based on the path — tells the user how to list the
    // resource type they're missing. Falls back to a generic "resource not
    // found" hint when the path doesn't match a known pattern.
    const hint = hintFor404(path);
    throw new SpycoreCliError(
      `Not found: ${errMsg}`,
      EXIT_USER_ERROR,
      hint,
    );
  }
  throw new SpycoreCliError(errMsg, EXIT_USER_ERROR);
}

function hintFor404(path: string): string {
  if (/\/conversations\//.test(path)) {
    return 'Conversation ID may be invalid. List with `spycore conversations list`.';
  }
  if (/\/files\//.test(path)) {
    return 'File ID may be invalid. List with `spycore files list`.';
  }
  if (/\/memor(y|ies)\//.test(path)) {
    return 'Memory ID may be invalid. List with `spycore memory list`.';
  }
  return 'Double-check the ID — list the resource type with `spycore <command> list`.';
}

/**
 * Pull the system errno code (ENOTFOUND, ECONNREFUSED, …) out of an error.
 * undici wraps the underlying Node error in `cause`, so we walk the chain.
 */
function extractErrnoCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export const api = {
  get: <T>(path: string, opts?: ApiOptions) => apiRequest<T>('GET', path, opts),
  post: <T>(path: string, opts?: ApiOptions) => apiRequest<T>('POST', path, opts),
  put: <T>(path: string, opts?: ApiOptions) => apiRequest<T>('PUT', path, opts),
  patch: <T>(path: string, opts?: ApiOptions) => apiRequest<T>('PATCH', path, opts),
  delete: <T>(path: string, opts?: ApiOptions) =>
    apiRequest<T>('DELETE', path, opts),
};

// Re-export the streaming helper so commands import everything from one
// place. The implementation lives in lib/sse.ts because the SSE wiring is
// substantial and worth its own module + tests.
export { streamRequest, type StreamEvent } from './sse.js';
