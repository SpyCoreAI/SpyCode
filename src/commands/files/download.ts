import { Command, Option } from 'commander';
import { createWriteStream, existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { request } from 'undici';
import ora, { type Ora } from 'ora';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api } from '../../lib/api.js';
import { getOutputOptions, json, success, warn } from '../../lib/output.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import {
  EXIT_NETWORK_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
  isSpycoreCliError,
} from '../../lib/errors.js';
import { formatFileSize } from '../../lib/files.js';

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

        const downloadUrl = file.url;
        if (!downloadUrl) {
          throw new SpycoreCliError(
            'No download URL available for this file.',
            EXIT_NETWORK_ERROR,
            'The file may be expired or inaccessible.',
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
          const answer = (
            await readSingleLineInput(`Overwrite ${outPath}? (y/N): `)
          )
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            warn('Cancelled.');
            return;
          }
        }

        const expectedBytes = Math.max(0, file.size ?? 0);
        const useSpinner =
          !getOutputOptions().json && process.stdout.isTTY === true;
        let spinner: Ora | null = null;
        if (useSpinner) {
          spinner = ora({
            text: `Downloading ${file.filename} (${formatFileSize(expectedBytes)})…`,
            stream: process.stderr,
          }).start();
        }

        const res = await request(downloadUrl);
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
            spinner.text = `Downloading ${file.filename} ${pct}% (${formatFileSize(
              received,
            )} / ${formatFileSize(expectedBytes)})`;
          } else {
            spinner.text = `Downloading ${file.filename} (${formatFileSize(received)})`;
          }
        };

        try {
          const sink = createWriteStream(outPath);
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
          spinner?.succeed(`Saved ${outPath} (${formatFileSize(received)})`);
        } catch (err) {
          spinner?.fail();
          const msg = err instanceof Error ? err.message : String(err);
          throw new SpycoreCliError(
            `Download interrupted: ${msg}`,
            EXIT_NETWORK_ERROR,
          );
        }

        if (getOutputOptions().json) {
          json({ id: file.id, output: outPath, size: received, mime: file.mimeType });
        } else if (!useSpinner) {
          success(`Saved ${outPath} (${formatFileSize(received)})`);
        }
      },
    );
}
