import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { request, type Dispatcher } from 'undici';
import FormData from 'form-data';
import { Readable } from 'node:stream';
import {
  EXIT_NETWORK_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
} from './errors.js';

export interface UploadFileOpts {
  /** Local path to the file. */
  path: string;
  /** Full URL of the upload endpoint, e.g. `${apiUrl}/api/files/upload`. */
  url: string;
  /** Auth + extra headers; content-type is set by form-data. */
  headers?: Record<string, string>;
  /** Override remote filename (defaults to basename of `path`). */
  remoteName?: string;
  /** Optional MIME hint sent with the field; server will validate. */
  mime?: string;
  /** Server-side category enum (defaults to CHAT_OTHER). */
  category?: string;
  /** Conversation/message linkage (rare from CLI). */
  conversationId?: string;
  messageId?: string;
  /** Progress callback fired as bytes flow. */
  onProgress?: (loaded: number, total: number) => void;
  /** Cancellation. */
  signal?: AbortSignal;
}

export interface UploadResult {
  id: string;
  url: string;
  size: number;
  mime: string;
  filename: string;
  expiresAt?: string | null;
}

/**
 * Upload a file as multipart/form-data, streaming from disk so the
 * whole payload never sits in memory at once. Hooks the read stream
 * with a counter so callers can render a progress bar.
 *
 * Errors are mapped to SpycoreCliError with stable exit codes:
 *   413 → "File exceeds plan limit" (EXIT_USER_ERROR + upgrade hint)
 *   415 → "Unsupported file type"
 *   network/abort → EXIT_NETWORK_ERROR
 *   user cancel → EXIT_USER_ERROR (Cancelled)
 */
export async function uploadFile(opts: UploadFileOpts): Promise<UploadResult> {
  const stat = statSync(opts.path);
  if (!stat.isFile()) {
    throw new SpycoreCliError(
      `Not a regular file: ${opts.path}`,
      EXIT_USER_ERROR,
    );
  }
  const totalBytes = stat.size;
  const remoteName = opts.remoteName?.trim() || basename(opts.path);

  const form = new FormData();
  let loaded = 0;
  const fileStream = createReadStream(opts.path);
  fileStream.on('data', (chunk: Buffer | string) => {
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    loaded += len;
    opts.onProgress?.(loaded, totalBytes);
  });
  form.append('file', fileStream, {
    filename: remoteName,
    contentType: opts.mime,
    knownLength: totalBytes,
  });
  if (opts.category) form.append('category', opts.category);
  if (opts.conversationId) form.append('conversationId', opts.conversationId);
  if (opts.messageId) form.append('messageId', opts.messageId);

  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
    ...form.getHeaders(),
  };
  // form-data computes content-length on demand and only when knownLength
  // was supplied for every appended part, which is true here.
  const contentLength = form.getLengthSync();
  if (Number.isFinite(contentLength)) {
    headers['content-length'] = String(contentLength);
  }

  let res: Dispatcher.ResponseData;
  try {
    res = await request(opts.url, {
      method: 'POST',
      headers,
      // form-data is a Node Readable; undici accepts that directly.
      body: form as unknown as Readable,
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new SpycoreCliError(
      `Upload failed: ${message}`,
      EXIT_NETWORK_ERROR,
      `Tried ${opts.url}.`,
    );
  }

  type ParsedBody = { success?: boolean; data?: unknown; error?: string };
  const status = res.statusCode;
  let parsed: ParsedBody | null = null;
  try {
    parsed = (await res.body.json()) as ParsedBody;
  } catch {
    parsed = null;
  }

  if (status === 413) {
    throw new SpycoreCliError(
      parsed?.error || 'File exceeds the per-plan upload limit.',
      EXIT_USER_ERROR,
      'Upgrade at https://spycore.ai/pricing',
    );
  }
  if (status === 415 || status === 400) {
    throw new SpycoreCliError(
      parsed?.error || `Upload rejected (HTTP ${status})`,
      EXIT_USER_ERROR,
    );
  }
  if (status === 401) {
    throw new SpycoreCliError(
      parsed?.error || 'Authentication failed',
      EXIT_USER_ERROR,
      'Run `spycore login` to re-authenticate.',
    );
  }
  if (status === 403) {
    throw new SpycoreCliError(
      parsed?.error || 'Permission denied',
      EXIT_USER_ERROR,
      'File uploads require Pro or higher. Upgrade at https://spycore.ai/pricing',
    );
  }
  if (status >= 500) {
    throw new SpycoreCliError(
      parsed?.error || `Server error (HTTP ${status})`,
      EXIT_NETWORK_ERROR,
      'Try again in a moment.',
    );
  }
  if (status < 200 || status >= 300 || !parsed || !parsed.success) {
    throw new SpycoreCliError(
      parsed?.error || `Upload failed (HTTP ${status})`,
      EXIT_USER_ERROR,
    );
  }

  const data = parsed.data as {
    id: string;
    url: string;
    size: number;
    filename: string;
    mimeType: string;
    expiresAt?: string | null;
  };
  return {
    id: data.id,
    url: data.url,
    size: data.size,
    mime: data.mimeType,
    filename: data.filename,
    expiresAt: data.expiresAt ?? null,
  };
}
