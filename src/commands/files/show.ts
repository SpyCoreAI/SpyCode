import { Command } from 'commander';
import { api } from '../../lib/api.js';
import { getOutputOptions, json, print } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  formatFileSize,
  isImageMime,
  isTextMime,
  relativeTime,
  shortMimeLabel,
} from '../../lib/files.js';
import { EXIT_USER_ERROR, SpycoreCliError, isSpycoreCliError } from '../../lib/errors.js';

interface FileDetail {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  // category/status are not declared on the server's fileSchema; left
  // optional for forward-compat (current responses strip them).
  category?: string;
  status?: string;
  createdAt: string;
  expiresAt?: string | null;
  /** Short-lived presigned download URL minted on each read by the server. */
  url?: string | null;
}

const PREVIEW_MAX_BYTES = 8_192;

export function registerFilesShowCommand(program: Command): void {
  program
    .command('show <id>')
    .description('Show metadata (and a small preview) for a file')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const root = cmd.parent?.parent;
      const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};

      let file: FileDetail;
      try {
        file = await api.get<FileDetail>(`/api/files/${encodeURIComponent(id)}`, {
          apiUrlOverride: parentOpts.apiUrl,
        });
      } catch (err) {
        if (isSpycoreCliError(err) && err.code === EXIT_USER_ERROR) {
          throw new SpycoreCliError(
            `File not found: ${id}`,
            EXIT_USER_ERROR,
            'Run `spycore files list` to see available IDs.',
          );
        }
        throw err;
      }

      if (getOutputOptions().json) {
        json(file);
        return;
      }

      // Server-controlled strings (id, filename, mimeType, category, status)
      // cross the display sanitizer before the terminal (SEC-013). Numbers and
      // the relativeTime/formatFileSize helpers produce bounded computed text.
      print(`ID:        ${sanitizeForDisplay(file.id)}`);
      print(`Name:      ${sanitizeForDisplay(file.filename)}`);
      print(
        `Type:      ${sanitizeForDisplay(shortMimeLabel(file.mimeType, file.filename))} (${sanitizeForDisplay(file.mimeType)})`,
      );
      print(`Size:      ${formatFileSize(file.size ?? 0)}`);
      print(`Uploaded:  ${relativeTime(file.createdAt)}`);
      if (file.expiresAt) {
        print(`Expires:   ${relativeTime(file.expiresAt)}`);
      }
      if (file.category) print(`Category:  ${sanitizeForDisplay(file.category)}`);
      if (file.status) print(`Status:    ${sanitizeForDisplay(file.status)}`);

      if (isImageMime(file.mimeType)) {
        print('');
        print('(Image preview not supported in terminal; download with `spycore files download`)');
        return;
      }

      // Inline a small text preview if the file is small + textual. We
      // pull through the signed URL the server attaches so we don't have
      // to chase another endpoint.
      if (
        isTextMime(file.mimeType) &&
        (file.size ?? 0) <= PREVIEW_MAX_BYTES &&
        file.url
      ) {
        try {
          const { request } = await import('undici');
          const res = await request(file.url);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const buf = await res.body.arrayBuffer();
            const text = Buffer.from(buf).toString('utf8');
            const clipped =
              text.length > PREVIEW_MAX_BYTES ? `${text.slice(0, PREVIEW_MAX_BYTES)}…` : text;
            print('');
            print('--- preview ---');
            // Untrusted file content → through the display sanitizer (SEC-013).
            print(sanitizeForDisplay(clipped));
          }
        } catch {
          // Best-effort preview; ignore failures.
        }
      }
    });
}
