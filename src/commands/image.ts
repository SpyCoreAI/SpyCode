import { Command, Option } from 'commander';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requestWithRedirects } from '../lib/http-redirect.js';
import type { Ora } from 'ora';
import { createSpinner } from '../lib/spinner.js';
import { api, streamRequest, type StreamEvent } from '../lib/api.js';
import {
  IMAGE_ATTACH_EXTS,
  IMAGE_ATTACH_MAX_BYTES,
  inspectAttachment,
  uploadImageAttachment,
} from '../lib/attachments.js';
import { createExclusiveTempWriteStream, formatFileSize } from '../lib/files.js';
import { imageExtensionFor } from '../lib/image-format.js';
import { getOutputOptions, json, success, warn } from '../lib/output.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';
import type { UploadResult } from '../lib/upload.js';
import {
  EXIT_NETWORK_ERROR,
  EXIT_USER_ERROR,
  isSpycoreCliError,
  SpycoreCliError,
} from '../lib/errors.js';

interface ConversationCreateResp {
  id: string;
  title: string;
  model: string;
}

const PROMPT_MIN = 3;
const PROMPT_MAX = 4_000;
/** Total bound on an image download (matches uploadFile's 120 s). */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000;

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
 *   verbatim - they named the destination, so we don't second-guess it.
 * - Otherwise the auto-generated name (`image_<timestamp>`) gets the extension
 *   detected from the response Content-Type, or sniffed from the leading bytes,
 *   falling back to a sane default.
 *
 * The first chunk is buffered so the magic-byte sniff can run before the
 * filename is committed; the rest streams straight to disk.
 *
 * Overwrite discipline: an explicit --output that already exists is refused
 * unless --force is given (createWriteStream used to truncate it silently);
 * an auto-generated name that already exists (same-second rerun) gets a
 * numeric suffix instead of overwriting.
 */
async function downloadImage(
  url: string,
  explicitOutput: string | undefined,
  opts?: { force?: boolean | undefined },
): Promise<DownloadedImage> {
  const explicitPath =
    explicitOutput && explicitOutput.length > 0 ? resolvePath(explicitOutput) : null;
  if (explicitPath && existsSync(explicitPath) && !opts?.force) {
    throw new SpycoreCliError(
      `Refusing to overwrite ${explicitPath}.`,
      EXIT_USER_ERROR,
      'Pass --force to overwrite, or --output to write elsewhere.',
    );
  }
  // Presigned S3/R2 URLs 302 to the object: follow redirects like a
  // normal client (bounded), instead of failing with "HTTP 302".
  // Total timeout: a stalled/trickling response must not hang the command
  // past the undici 300 s inactivity defaults (L15). Redirects are
  // followed manually (lib/http-redirect.ts): undici 6.29.1 throws on
  // `maxRedirections` passed to request().
  const res = await requestWithRedirects(url, {
    signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
  });
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

  // Explicit output was existence-checked up front; an auto-generated name
  // gets a numeric suffix when it collides (same-second rerun) instead of
  // truncating the previous image.
  let outPath: string;
  if (explicitPath) {
    outPath = explicitPath;
  } else {
    const ext = imageExtensionFor(res.headers['content-type'], firstChunk);
    const base = `image_${todaySlug()}`;
    outPath = resolvePath(`${base}${ext}`);
    for (let n = 2; existsSync(outPath); n += 1) {
      outPath = resolvePath(`${base}-${n}${ext}`);
    }
  }

  let total = firstChunk.length;
  // Write to a temp file in the same directory and rename on success (the
  // files/download.ts pattern): an interrupted/failed download used to
  // leave a truncated file at the final path that looked complete, and
  // the --force path truncated a pre-existing file before the body was
  // verified. The temp is deleted on any failure.
  const { stream: sink, path: tmpPath } = createExclusiveTempWriteStream(
    dirname(outPath),
    `${basename(outPath)}.tmp-${process.pid}`,
  );
  const monitored = Readable.from(
    (async function* () {
      if (firstChunk.length > 0) yield firstChunk;
      // The iterator is stateful - resume it from where the sniff left off.
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        const buf =
          next.value instanceof Buffer ? next.value : Buffer.from(next.value);
        total += buf.length;
        yield buf;
      }
    })(),
  );
  try {
    await pipeline(monitored, sink);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SpycoreCliError(`Image download interrupted: ${msg}`, EXIT_NETWORK_ERROR);
  }
  // Size verification against Content-Length when the server sent one: a
  // cleanly truncated stream used to be saved and reported as complete.
  const expected = Number(res.headers['content-length']);
  if (Number.isFinite(expected) && expected > 0 && total !== expected) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw new SpycoreCliError(
      `Image download incomplete: received ${formatFileSize(total)} of ${formatFileSize(expected)} - the file was not saved.`,
      EXIT_NETWORK_ERROR,
      'Retry the download; if it keeps failing, the server or network is truncating the stream.',
    );
  }
  renameSync(tmpPath, outPath);
  return { path: outPath, size: total };
}

const EDIT_USAGE = 'Usage: spycore image edit <file> -p "<instruction>"';

/**
 * `spycore image edit <file> -p "<instruction>"` - edit a local image with
 * Hephaestus. Mirrors the web's edit contract exactly: the source is uploaded
 * through the 1.2 attachment plumbing (`POST /api/files/upload`, category
 * CHAT_IMAGE, same type/size limits), then the edit rides the standard
 * `/api/chat/stream` request as `editSourceImageUrl` on a fresh conversation.
 * The result is fetched and saved exactly like generation.
 */
async function runImageEdit(
  inputArgs: string[],
  opts: { output?: string; style?: string; count?: string; prompt?: string; force?: boolean },
  cmd: Command,
): Promise<void> {
  const root = cmd.parent;
  const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};

  // Generation-only knobs are meaningless on an edit - reject loudly rather
  // than silently ignoring them. (--style maps to the conversation's stored
  // styleVariance, which only the generate flow threads through.)
  if (cmd.getOptionValueSource('style') === 'cli') {
    throw new SpycoreCliError(
      '--style is not supported for image edits.',
      EXIT_USER_ERROR,
      EDIT_USAGE,
    );
  }
  if (cmd.getOptionValueSource('count') === 'cli') {
    throw new SpycoreCliError(
      '--count is not supported for image edits.',
      EXIT_USER_ERROR,
      EDIT_USAGE,
    );
  }

  if (inputArgs.length === 0) {
    throw new SpycoreCliError('Missing input image.', EXIT_USER_ERROR, EDIT_USAGE);
  }
  if (inputArgs.length > 1) {
    throw new SpycoreCliError(
      'Image edit takes exactly one input file - put the instruction in --prompt.',
      EXIT_USER_ERROR,
      EDIT_USAGE,
    );
  }
  const input = inputArgs[0]!;

  const instruction = (opts.prompt ?? '').trim();
  if (instruction.length === 0) {
    throw new SpycoreCliError('Missing --prompt.', EXIT_USER_ERROR, EDIT_USAGE);
  }
  if (instruction.length < PROMPT_MIN) {
    throw new SpycoreCliError(
      `Prompt must be at least ${PROMPT_MIN} characters.`,
      EXIT_USER_ERROR,
    );
  }
  if (instruction.length > PROMPT_MAX) {
    throw new SpycoreCliError(
      `Prompt exceeds ${PROMPT_MAX} characters (got ${instruction.length}).`,
      EXIT_USER_ERROR,
    );
  }

  const supportedHint = `Supported: ${IMAGE_ATTACH_EXTS.join(', ')} up to ${formatFileSize(IMAGE_ATTACH_MAX_BYTES)}.`;
  if (/^https?:\/\//i.test(input)) {
    throw new SpycoreCliError(
      'URLs are not supported as edit sources - pass a local image file.',
      EXIT_USER_ERROR,
      supportedHint,
    );
  }

  const cwd = process.cwd();
  const absPath = resolvePath(cwd, input);
  if (!existsSync(absPath)) {
    throw new SpycoreCliError(`Input image not found: ${input}`, EXIT_USER_ERROR);
  }
  const ext = extname(absPath).toLowerCase();
  if (!(IMAGE_ATTACH_EXTS as readonly string[]).includes(ext)) {
    throw new SpycoreCliError(
      `Unsupported input type for image edit${ext ? ` (${ext})` : ''}.`,
      EXIT_USER_ERROR,
      supportedHint,
    );
  }
  // Readability / regular-file / non-empty / IMAGE_ATTACH_MAX_BYTES - the exact
  // 1.2 attachment validation, so limits and error copy stay in one place. The
  // cap is NAMED rather than spelled out: this comment said "10 MB" and went on
  // saying it after the constant moved, which is the whole defect class.
  const att = inspectAttachment(input, cwd);

  const useSpinner = !getOutputOptions().json && process.stdout.isTTY === true;
  let spinner: Ora | null = null;
  if (useSpinner) {
    spinner = createSpinner({ text: 'Uploading image…', stream: process.stderr }).start();
  }

  let uploaded: UploadResult;
  let conversation: ConversationCreateResp;
  try {
    // Upload through the reused 1.2 plumbing; server-side plan/size/type
    // errors surface through uploadFile's existing clean mapping (Free-plan
    // uploads get the Pro upgrade message + pricing hint).
    uploaded = await uploadImageAttachment(att, { apiUrlOverride: parentOpts.apiUrl });

    // Fresh thread to host the edit - the same pattern generation uses; the
    // id is dropped afterwards.
    conversation = await api.post<ConversationCreateResp>('/conversations', {
      apiUrlOverride: parentOpts.apiUrl,
      body: { model: 'HEPHAESTUS' },
    });
  } catch (err) {
    spinner?.fail();
    throw err;
  }

  if (spinner) spinner.text = 'Editing image…';

  const imageUrls: string[] = [];
  let revisedPrompt = '';
  let errorMessage: string | null = null;

  try {
    for await (const event of streamRequest(
      '/api/chat/stream',
      {
        // The exact web edit contract - nothing more, nothing less. The
        // server self-identifies the edit via editSourceImageUrl and forces
        // the image model; charging runs through the existing image path.
        conversationId: conversation.id,
        message: instruction,
        model: 'HEPHAESTUS',
        editSourceImageUrl: uploaded.url,
      },
      { apiUrlOverride: parentOpts.apiUrl },
    )) {
      const data = (event as StreamEvent).data as
        | (Record<string, unknown> & { type?: string })
        | undefined;
      if (!data || typeof data !== 'object') continue;
      switch (data.type) {
        case 'image': {
          // R3-13: non-string elements in `urls` used to reach
          // downloadImage() as-is and crash with a raw TypeError - keep
          // only strings; an empty result still fails cleanly downstream
          // ("Image edit finished without returning a URL").
          const urls = Array.isArray(data.urls)
            ? data.urls.filter((u): u is string => typeof u === 'string')
            : [];
          imageUrls.push(...urls);
          if (typeof data.revisedPrompt === 'string') {
            revisedPrompt = data.revisedPrompt;
          }
          break;
        }
        case 'error': {
          errorMessage = String(data.message ?? 'Image edit failed');
          break;
        }
        case 'done':
        default:
          break;
      }
    }
  } catch (err) {
    spinner?.fail();
    // The pre-stream 403 for a Free plan carries the raw `plan_required`
    // code - replace it with the actionable upgrade message.
    if (isSpycoreCliError(err) && /plan_required/i.test(err.message)) {
      throw new SpycoreCliError(
        'Image editing requires a Pro plan or higher.',
        EXIT_USER_ERROR,
        'Upgrade at https://spycore.ai/pricing',
      );
    }
    throw err;
  }

  if (errorMessage) {
    spinner?.fail();
    const lower = errorMessage.toLowerCase();
    if (lower.includes('moder')) {
      throw new SpycoreCliError(
        'Request was rejected by content moderation.',
        EXIT_USER_ERROR,
      );
    }
    if (lower.includes('plan') || lower.includes('upgrade')) {
      throw new SpycoreCliError(
        sanitizeForDisplay(errorMessage),
        EXIT_USER_ERROR,
        'Upgrade at https://spycore.ai/pricing',
      );
    }
    if (lower.includes('quota') || lower.includes('limit')) {
      throw new SpycoreCliError(
        sanitizeForDisplay(errorMessage),
        EXIT_USER_ERROR,
        'Run `spycore usage` to see remaining capacity.',
      );
    }
    // Provider/moderation details stay server-side; the CLI shows one
    // generic, actionable line.
    throw new SpycoreCliError(
      'Image edit failed - try rephrasing the prompt.',
      EXIT_USER_ERROR,
    );
  }

  if (imageUrls.length === 0) {
    spinner?.fail();
    throw new SpycoreCliError(
      'Image edit finished without returning a URL.',
      EXIT_NETWORK_ERROR,
    );
  }

  if (spinner) spinner.text = 'Downloading image…';

  // Extra URLs after the first used to be silently dropped - say so, and
  // name the dropped ones in machine output.
  const extraUrls = imageUrls.slice(1);
  if (extraUrls.length > 0) {
    warn(`The server returned ${imageUrls.length} images - saving only the first; the rest were dropped.`);
  }

  const targetUrl = imageUrls[0]!;
  const { path: outPath, size } = await downloadImage(targetUrl, opts.output, { force: opts.force });

  spinner?.succeed(`Saved ${outPath} (${formatFileSize(size)})`);
  if (!useSpinner && !getOutputOptions().json) {
    success(`Saved ${outPath} (${formatFileSize(size)})`);
  }

  if (getOutputOptions().json) {
    json({
      mode: 'edit',
      prompt: instruction,
      input: att.displayPath,
      sourceFileId: uploaded.id,
      url: targetUrl,
      ...(extraUrls.length > 0 ? { droppedUrls: extraUrls } : {}),
      localPath: outPath,
      size,
      revisedPrompt: revisedPrompt || null,
    });
  } else if (revisedPrompt && revisedPrompt !== instruction) {
    process.stderr.write(
      `\nPrompt revised by the model:\n  ${sanitizeForDisplay(revisedPrompt)}\n`,
    );
  }
}

export function registerImageCommand(program: Command): void {
  program
    .command('image <prompt...>')
    .description(
      'Generate an image with Hephaestus and save it to disk, or edit one: spycore image edit <file> -p "<instruction>"',
    )
    .addOption(new Option('-o, --output <path>', 'Local path for the saved image'))
    .addOption(new Option('-f, --force', 'Overwrite the existing file at --output'))
    .addOption(
      new Option('--style <style>', 'Generation style hint')
        .choices(['low', 'medium', 'high'])
        .default('medium'),
    )
    .addOption(new Option('-c, --count <n>', 'How many images to generate (currently 1)').default('1'))
    .addOption(
      new Option('-p, --prompt <instruction>', 'Edit instruction (only with `spycore image edit`)'),
    )
    .action(
      async (
        promptArg: string[],
        opts: { output?: string; style?: string; count?: string; prompt?: string; force?: boolean },
        cmd: Command,
      ) => {
        // `spycore image edit <file> -p "…"` - the edit sub-surface. Exact
        // first-token match only: a quoted generation prompt that merely
        // starts with the word "edit" arrives as a single multi-word token
        // and falls through to generation unchanged.
        if ((promptArg ?? [])[0] === 'edit') {
          return runImageEdit((promptArg ?? []).slice(1), opts, cmd);
        }

        const root = cmd.parent;
        const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};

        // --prompt belongs to the edit surface; on a generation it would be
        // silently dead weight, so reject it with the correct usage instead.
        if (opts.prompt !== undefined) {
          throw new SpycoreCliError(
            '--prompt is only used with `spycore image edit` - pass the generation prompt as arguments.',
            EXIT_USER_ERROR,
            EDIT_USAGE,
          );
        }

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
        // count of 1 (or omitted) is unchanged - no notice, same as before.
        // But an invalid count (0, -1, non-numeric) used to silently
        // produce 1 image with no notice - only a positive integer is
        // accepted now. (parseIntFlag would clamp 0 to 1, which is exactly
        // the silent behavior being fixed, so the check is explicit here.)
        const countRaw = (opts.count ?? '1').trim();
        if (!/^\d+$/.test(countRaw) || !Number.isSafeInteger(Number(countRaw)) || Number(countRaw) < 1) {
          throw new SpycoreCliError(
            `Invalid --count: "${opts.count ?? '1'}" is not a positive integer.`,
            EXIT_USER_ERROR,
            'Pass --count <n> with n >= 1.',
          );
        }
        const requestedCount = Number(countRaw);
        const count = 1;
        if (requestedCount > 1) {
          warn(
            "Generating more than one image per request isn't supported yet - generating a single image.",
          );
        }

        // The API requires conversation context for /api/chat/stream so we
        // make a fresh thread to host this generation. The id is silently
        // dropped after - we don't track it in lastConversationId since image
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
        // user actually passed --style - omitting it leaves the request
        // sequence byte-for-byte identical to before. Best-effort: a settings
        // hiccup must never cost the user their generated image.
        if (cmd.getOptionValueSource('style') === 'cli' && opts.style) {
          try {
            await api.patch(`/conversations/${encodeURIComponent(conversation.id)}/settings`, {
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
          spinner = createSpinner({
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
                // R3-13: see the edit path above - non-string `urls`
                // elements are dropped, never passed to downloadImage().
                const urls = Array.isArray(data.urls)
                  ? data.urls.filter((u): u is string => typeof u === 'string')
                  : [];
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
          // The server sanitizes moderation messages. We surface the
          // message verbatim and add a generic hint.
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

        // Extra URLs after the first used to be silently dropped - say so,
        // and name the dropped ones in machine output.
        const extraUrls = imageUrls.slice(1);
        if (extraUrls.length > 0) {
          warn(`The server returned ${imageUrls.length} images - saving only the first; the rest were dropped.`);
        }

        const targetUrl = imageUrls[0]!;
        const { path: outPath, size } = await downloadImage(targetUrl, opts.output, { force: opts.force });

        spinner?.succeed(`Saved ${outPath} (${formatFileSize(size)})`);
        if (!useSpinner && !getOutputOptions().json) {
          success(`Saved ${outPath} (${formatFileSize(size)})`);
        }

        if (getOutputOptions().json) {
          json({
            prompt,
            url: targetUrl,
            ...(extraUrls.length > 0 ? { droppedUrls: extraUrls } : {}),
            localPath: outPath,
            size,
            revisedPrompt: revisedPrompt || null,
            count,
            style: opts.style ?? 'medium',
          });
        } else if (revisedPrompt && revisedPrompt !== prompt) {
          // MODEL-authored text (API data.revisedPrompt) reaching the terminal.
          process.stderr.write(
            `\nPrompt revised by the model:\n  ${sanitizeForDisplay(revisedPrompt)}\n`,
          );
        }
      },
    );
}
