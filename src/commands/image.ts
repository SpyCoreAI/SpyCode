import { Command, Option } from 'commander';
import { createWriteStream } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';
import ora, { type Ora } from 'ora';
import { api, streamRequest, type StreamEvent } from '../lib/api.js';
import { formatFileSize } from '../lib/files.js';
import { imageExtensionFor } from '../lib/image-format.js';
import { getOutputOptions, json, success, warn } from '../lib/output.js';
import {
  EXIT_NETWORK_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
} from '../lib/errors.js';

interface ConversationCreateResp {
  id: string;
  title: string;
  model: string;
}

const PROMPT_MIN = 3;
const PROMPT_MAX = 4_000;

function todaySlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface DownloadedImage {
  /** Absolute path the bytes were written to (extension reflects the bytes). */
  path: string;
  /** Total bytes written. */
  size: number;
}

/**
 * Download an image to disk, choosing the file extension from the ACTUAL bytes
 * received rather than a hard-coded guess.
 *
 * - When `explicitOutput` is given (`--output`), the user's path is honored
 *   verbatim — they named the destination, so we don't second-guess it.
 * - Otherwise the auto-generated name (`image_<timestamp>`) gets the extension
 *   detected from the response Content-Type, or sniffed from the leading bytes,
 *   falling back to a sane default.
 *
 * The first chunk is buffered so the magic-byte sniff can run before the
 * filename is committed; the rest streams straight to disk.
 */
async function downloadImage(
  url: string,
  explicitOutput: string | undefined,
): Promise<DownloadedImage> {
  const res = await request(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new SpycoreCliError(
      `Image download failed: HTTP ${res.statusCode}`,
      EXIT_NETWORK_ERROR,
    );
  }

  const body = res.body as unknown as AsyncIterable<Buffer | Uint8Array>;
  const iterator = body[Symbol.asyncIterator]();
  const first = await iterator.next();
  const firstChunk: Buffer = first.done
    ? Buffer.alloc(0)
    : first.value instanceof Buffer
      ? first.value
      : Buffer.from(first.value);

  const outPath = resolvePath(
    explicitOutput && explicitOutput.length > 0
      ? explicitOutput
      : `image_${todaySlug()}${imageExtensionFor(res.headers['content-type'], firstChunk)}`,
  );

  let total = firstChunk.length;
  const sink = createWriteStream(outPath);
  const monitored = Readable.from(
    (async function* () {
      if (firstChunk.length > 0) yield firstChunk;
      // The iterator is stateful — resume it from where the sniff left off.
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        const buf =
          next.value instanceof Buffer ? next.value : Buffer.from(next.value);
        total += buf.length;
        yield buf;
      }
    })(),
  );
  await pipeline(monitored, sink);
  return { path: outPath, size: total };
}

export function registerImageCommand(program: Command): void {
  program
    .command('image <prompt...>')
    .description('Generate an image with Hephaestus and save it to disk')
    .addOption(new Option('-o, --output <path>', 'Local path for the saved image'))
    .addOption(
      new Option('--style <style>', 'Generation style hint')
        .choices(['low', 'medium', 'high'])
        .default('medium'),
    )
    .addOption(new Option('-c, --count <n>', 'How many images to generate (currently 1)').default('1'))
    .action(
      async (
        promptArg: string[],
        opts: { output?: string; style?: string; count?: string },
        cmd: Command,
      ) => {
        const root = cmd.parent;
        const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};
        const prompt = (promptArg ?? []).join(' ').trim();

        if (prompt.length < PROMPT_MIN) {
          throw new SpycoreCliError(
            `Prompt must be at least ${PROMPT_MIN} characters.`,
            EXIT_USER_ERROR,
          );
        }
        if (prompt.length > PROMPT_MAX) {
          throw new SpycoreCliError(
            `Prompt exceeds ${PROMPT_MAX} characters (got ${prompt.length}).`,
            EXIT_USER_ERROR,
          );
        }

        // Multiple images per request aren't supported yet. Instead of hard-
        // erroring, clamp to a single image and print one friendly notice
        // (warn() is suppressed in --json, keeping machine output valid). A
        // count of 1 (or omitted) is unchanged — no notice, same as before.
        const requestedCount = Number(opts.count ?? 1);
        const count = 1;
        if (Number.isFinite(requestedCount) && requestedCount > 1) {
          warn(
            "Generating more than one image per request isn't supported yet — generating a single image.",
          );
        }

        // The API requires conversation context for /api/chat/stream so we
        // make a fresh thread to host this generation. The id is silently
        // dropped after — we don't track it in lastConversationId since image
        // gen isn't a chat to resume.
        const conversation = await api.post<ConversationCreateResp>(
          '/conversations',
          {
            apiUrlOverride: parentOpts.apiUrl,
            body: { model: 'HEPHAESTUS' },
          },
        );

        // Thread an explicitly-chosen --style through to the backend the same
        // way the web composer does: the image "style" knob is
        // `imageParams.styleVariance` (low|medium|high), persisted on the
        // conversation via the settings endpoint (the chat-stream body strips
        // any undeclared field, so style must ride here). Only sent when the
        // user actually passed --style — omitting it leaves the request
        // sequence byte-for-byte identical to before. Best-effort: a settings
        // hiccup must never cost the user their generated image.
        if (cmd.getOptionValueSource('style') === 'cli' && opts.style) {
          try {
            await api.patch(`/conversations/${conversation.id}/settings`, {
              apiUrlOverride: parentOpts.apiUrl,
              body: { imageParams: { styleVariance: opts.style } },
            });
          } catch {
            warn('Could not apply the requested style; generating with defaults.');
          }
        }

        const useSpinner =
          !getOutputOptions().json && process.stdout.isTTY === true;
        let spinner: Ora | null = null;
        if (useSpinner) {
          spinner = ora({
            text: 'Generating image…',
            stream: process.stderr,
          }).start();
        }

        const imageUrls: string[] = [];
        let revisedPrompt = '';
        let errorMessage: string | null = null;

        try {
          for await (const event of streamRequest(
            '/api/chat/stream',
            {
              conversationId: conversation.id,
              message: prompt,
              model: 'HEPHAESTUS',
            },
            { apiUrlOverride: parentOpts.apiUrl },
          )) {
            const data = (event as StreamEvent).data as
              | (Record<string, unknown> & { type?: string })
              | undefined;
            if (!data || typeof data !== 'object') continue;
            switch (data.type) {
              case 'image': {
                const urls = Array.isArray(data.urls) ? (data.urls as string[]) : [];
                imageUrls.push(...urls);
                if (typeof data.revisedPrompt === 'string') {
                  revisedPrompt = data.revisedPrompt;
                }
                break;
              }
              case 'error': {
                errorMessage = String(data.message ?? 'Image generation failed');
                break;
              }
              case 'done':
              default:
                break;
            }
          }
        } catch (err) {
          spinner?.fail();
          throw err;
        }

        if (errorMessage) {
          spinner?.fail();
          // Identity protection: the server scrubs upstream provider
          // names from moderation messages. We surface the message
          // verbatim and add a generic hint.
          const lower = errorMessage.toLowerCase();
          if (lower.includes('moder')) {
            throw new SpycoreCliError(
              'Request was rejected by content moderation.',
              EXIT_USER_ERROR,
            );
          }
          if (lower.includes('plan') || lower.includes('upgrade')) {
            throw new SpycoreCliError(
              errorMessage,
              EXIT_USER_ERROR,
              'Upgrade at https://spycore.ai/pricing',
            );
          }
          if (lower.includes('quota') || lower.includes('limit')) {
            throw new SpycoreCliError(
              errorMessage,
              EXIT_USER_ERROR,
              'Run `spycore usage` to see remaining capacity.',
            );
          }
          throw new SpycoreCliError(errorMessage, EXIT_USER_ERROR);
        }

        if (imageUrls.length === 0) {
          spinner?.fail();
          throw new SpycoreCliError(
            'Image generation finished without returning a URL.',
            EXIT_NETWORK_ERROR,
          );
        }

        if (spinner) spinner.text = 'Downloading image…';

        const targetUrl = imageUrls[0]!;
        const { path: outPath, size } = await downloadImage(targetUrl, opts.output);

        spinner?.succeed(`Saved ${outPath} (${formatFileSize(size)})`);
        if (!useSpinner && !getOutputOptions().json) {
          success(`Saved ${outPath} (${formatFileSize(size)})`);
        }

        if (getOutputOptions().json) {
          json({
            prompt,
            url: targetUrl,
            localPath: outPath,
            size,
            revisedPrompt: revisedPrompt || null,
            count,
            style: opts.style ?? 'medium',
          });
        } else if (revisedPrompt && revisedPrompt !== prompt) {
          process.stderr.write(`\nPrompt revised by the model:\n  ${revisedPrompt}\n`);
        }
      },
    );
}
