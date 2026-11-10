import { Command, Option } from 'commander';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import type { Ora } from 'ora';
import { createSpinner } from '../../lib/spinner.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api, unexpectedServerResponse } from '../../lib/api.js';
import { getOutputOptions, json, success, warn } from '../../lib/output.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import {
  EXIT_NETWORK_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
  isSpycoreCliError,
} from '../../lib/errors.js';
import { createExclusiveTempWriteStream, formatFileSize } from '../../lib/files.js';
import { requestWithRedirects } from '../../lib/http-redirect.js';
import { display } from '../../lib/sanitize-display.js';

interface FileDetail {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Short-lived presigned download URL minted on each read by the server. */
  url?: string | null;
  createdAt: string;
}

export function registerFilesDownloadCommand(program: Command): void {
  program
    .command('download <id>')
    .description('Download a file to disk')
    .addOption(new Option('-o, --output <path>', 'Local path (defaults to the original filename)'))
    .addOption(new Option('-f, --force', 'Overwrite an existing file at the destination'))
    .action(
      async (
        id: string,
        opts: { output?: string; force?: boolean },
        cmd: Command,
      ) => {
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

        const downloadUrl = typeof file.url === 'string' ? file.url : undefined;
        if (!downloadUrl) {
          throw new SpycoreCliError(
            'No download URL available for this file.',
            EXIT_NETWORK_ERROR,
            'The file may be expired or inaccessible.',
          );
        }
        // R3-4: a non-string server filename/mimeType used to crash
        // basename() below with a raw TypeError. Coerce to '' (the
        // files/list.ts guard) instead of trusting the declared shape.
        if (typeof file.filename !== 'string') file.filename = '';
        if (typeof file.mimeType !== 'string') file.mimeType = '';
        // A coerced-empty filename with no --output would resolve to the
        // working directory itself and fail mid-download with a confusing
        // EISDIR - refuse up front with a clean, actionable error instead.
        if ((!opts.output || opts.output.length === 0) && file.filename.length === 0) {
          throw new SpycoreCliError(
            'The server did not provide a filename for this file.',
            EXIT_USER_ERROR,
            'Pass --output <path> to choose where to save it.',
          );
        }

        const outPath = resolvePath(
          opts.output && opts.output.length > 0 ? opts.output : basename(file.filename),
        );
        if (existsSync(outPath) && !opts.force) {
          if (process.stdin.isTTY !== true) {
            throw new SpycoreCliError(
              `Refusing to overwrite ${outPath}.`,
              EXIT_USER_ERROR,
              'Pass --force to overwrite, or --output to write elsewhere.',
            );
          }
          // APPROVAL PROMPT. `outPath` derives from the server-supplied
          // filename via basename() when --output is absent, so it carries
          // whatever the server put there . The value handed to the
          // filesystem below is deliberately NOT sanitized - only what is
          // rendered is.
          const answer = (
            await readSingleLineInput(display`Overwrite ${outPath}? (y/N): `)
          )
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            warn('Cancelled.');
            return;
          }
        }

        // R3-21: the declared size is the expected byte count the
        // truncation check below enforces - a non-numeric size used to
        // make `Math.max(0, 'abc')` NaN, which silently disabled the
        // check and saved truncated deliveries as complete. Validate
        // up front, mirroring upload.ts (lib/upload.ts): the size must
        // be a finite, non-negative number, or the record is malformed.
        if (
          typeof file.size !== 'number' ||
          !Number.isFinite(file.size) ||
          file.size < 0
        ) {
          throw unexpectedServerResponse('file record has a non-numeric size');
        }

        const expectedBytes = Math.max(0, file.size ?? 0);
        const useSpinner =
          !getOutputOptions().json && process.stdout.isTTY === true;
        let spinner: Ora | null = null;
        if (useSpinner) {
          spinner = createSpinner({
            text: display`Downloading ${file.filename} (${formatFileSize(expectedBytes)})…`,
            stream: process.stderr,
          }).start();
        }

        // Presigned S3/R2 URLs 302 to the object: follow redirects like a
        // normal client (bounded), instead of failing with "HTTP 302".
        // Total timeout: a stalled/trickling response must not hang the
        // command past the undici 300 s inactivity defaults. Redirects are
        // followed manually (lib/http-redirect.ts): undici 6.29.1 throws on
        // `maxRedirections` passed to request().
        const res = await requestWithRedirects(downloadUrl, {
          signal: AbortSignal.timeout(120_000),
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          spinner?.fail();
          throw new SpycoreCliError(
            `Download failed: HTTP ${res.statusCode}`,
            EXIT_NETWORK_ERROR,
          );
        }

        let received = 0;
        const reportEvery = Math.max(64 * 1024, Math.floor(expectedBytes / 50));
        let nextReport = reportEvery;
        const onProgress = (delta: number) => {
          received += delta;
          if (!spinner) return;
          if (received < nextReport && received < expectedBytes) return;
          nextReport = received + reportEvery;
          if (expectedBytes > 0) {
            const pct = Math.min(100, Math.floor((received / expectedBytes) * 100));
            spinner.text = display`Downloading ${file.filename} ${pct}% (${formatFileSize(
              received,
            )} / ${formatFileSize(expectedBytes)})`;
          } else {
            spinner.text = display`Downloading ${file.filename} (${formatFileSize(received)})`;
          }
        };

        // Write to a temp file first; rename on success so a failed
        // download doesn't leave a truncated file that looks complete.
        // O_EXCL: never follow a pre-existing name - a planted symlink at
        // the predictable `.tmp-<pid>` path must fail, not be written.
        // Opened before the try so the catch can clean up the actual name.
        const { stream: sink, path: tmpPath } = createExclusiveTempWriteStream(
          dirname(outPath),
          `${basename(outPath)}.tmp-${process.pid}`,
        );
        try {
          // Tee the body through our progress counter without losing chunks.
          const body = res.body as unknown as NodeJS.ReadableStream;
          const monitored = Readable.from(
            (async function* () {
              for await (const chunk of body) {
                const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
                onProgress(buf.length);
                yield buf;
              }
            })(),
          );
          await pipeline(monitored, sink);
          // Size verification: a cleanly truncated stream used to be
          // renamed into place and reported as complete. The metadata size
          // is the expected byte count - refuse a short (or long) delivery
          // instead of saving it. R3-21: gated on finiteness, not `> 0`,
          // so a declared size of 0 with a non-empty body also refuses
          // (the old `> 0` gate waved it through).
          if (Number.isFinite(expectedBytes) && received !== expectedBytes) {
            try {
              unlinkSync(tmpPath);
            } catch {
              // ignore - the catch below retries the cleanup
            }
            throw new SpycoreCliError(
              `Download incomplete: received ${formatFileSize(received)} of ${formatFileSize(expectedBytes)} - the file was not saved.`,
              EXIT_NETWORK_ERROR,
              'Retry the download; if it keeps failing, the server or network is truncating the stream.',
            );
          }
          renameSync(tmpPath, outPath);
          spinner?.succeed(display`Saved ${outPath} (${formatFileSize(received)})`);
        } catch (err) {
          spinner?.fail();
          // Clean up the temp file on failure (the O_EXCL name actually used).
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore
          }
          const msg = err instanceof Error ? err.message : String(err);
          throw new SpycoreCliError(
            `Download interrupted: ${msg}`,
            EXIT_NETWORK_ERROR,
          );
        }

        if (getOutputOptions().json) {
          json({ id: file.id, output: outPath, size: received, mime: file.mimeType });
        } else if (!useSpinner) {
          success(display`Saved ${outPath} (${formatFileSize(received)})`);
        }
      },
    );
}
