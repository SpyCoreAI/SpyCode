/**
 * Shared attachment core for `--attach` (chat + agent) and the TUI `/attach`.
 *
 * Transport mirrors the web chat exactly:
 * • IMAGES (.png .jpg .jpeg .webp .gif) are uploaded through the existing
 * `POST /api/files/upload` multipart route (category CHAT_IMAGE) and the
 * resulting FILE IDs ride the stream request's existing `attachments`
 * field - the server resolves them to imageUrls for vision models.
 * Caps EQUAL the server's own: 20 MB per image (MAX_FILE_BYTES, the
 * multipart ceiling - the same number the web composer carries) and 10
 * images per message (the server schema caps `attachments` at 10). Both
 * are bound to the server by tests/limits-contract.test.ts; this header
 * said "10 MB" for weeks after the real cap moved, which is precisely why
 * the numbers are no longer trusted to prose.
 * • TEXT FILES are read locally and inlined into the message as clearly
 * delimited per-file blocks with a relative-path header. This is
 * USER-OWNED content - no untrusted-content wrapper - but anything echoed
 * to the terminal goes through sanitize-display at the render boundary.
 * The server caps the stream `message` at 32,000 chars (Fastify + Zod),
 * so text inlining is budgeted: 24,000 chars per file (truncated with an
 * explicit marker), and the assembled wire message is checked against the
 * 32,000 cap with a clean, actionable error - never a silent trim/drop.
 *
 * Vision gating: only Hermes and Minos accept image input (the server would
 * otherwise silently switch the turn to Minos); the CLI gates up front with an
 * actionable error instead, naming the SpyCore vision models.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { detectMime, formatFileSize } from './files.js';
import { getToken } from './auth.js';
import { isTrustedTokenHost, resolveApiUrl } from './config.js';
import { uploadFile, type UploadResult } from './upload.js';
import { MODEL_DISPLAY } from './models.js';
import { EXIT_USER_ERROR, SpycoreCliError } from './errors.js';

/** Image extensions accepted for upload - the web/server-allowed raster set. */
export const IMAGE_ATTACH_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

/**
 * Per-image size cap.
 *
 * EQUALS the server's `MAX_FILE_BYTES` (server/src/config/security.ts) - the
 * @fastify/multipart `limits.fileSize` that is the REAL binding limit of every
 * upload path, and the same number the web composer's `MAX_UPLOAD_BYTES`
 * carries (apps/web/src/lib/security.ts).
 *
 * This said 10 MB under the comment "mirrors the web chat input's
 * client-side MAX_BYTES" - which was FALSE, not merely stale: web moved to
 * 20 MB in E-7 and the CLI never followed, so a 15 MB image the server would
 * have accepted was rejected locally. The intent was always EQUALITY, so the
 * gap was drift, never a deliberate tightening. The web hit this exact defect
 * first and recorded the ruling (landmine 35: "the project-files panel already
 * used the true number, so the composer was the outlier"); the CLI was the last
 * outlier left.
 *
 * Bound by tests/limits-contract.test.ts, which reads the server's own
 * constant. A hand-typed mirror is what produced this defect twice.
 */
export const IMAGE_ATTACH_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/** Images per message - mirrors the web's MAX_FILES and the server's attachments max(10). */
export const MAX_IMAGES_PER_MESSAGE = 10;

/**
 * Per-file inline cap for text attachments. Content beyond it is cut with an
 * explicit `[attachment truncated …]` marker (and a user-visible warning) -
 * the same visible-truncation pattern the web-content tools use.
 */
export const TEXT_ATTACH_MAX_CHARS = 24_000;

/**
 * The server's hard cap on the stream `message` field. The assembled wire
 * message (context injection + user text + inlined file blocks) must fit it;
 * exceeding it fails with a clean error rather than a server 400.
 *
 * Defined in `wire-limits.ts` (a zero-import leaf) and re-exported here so the
 * agent's tool layer can honor the SAME number without dragging this module's
 * undici/upload graph into it. Value unchanged: 32_000.
 */
export { WIRE_MESSAGE_MAX_CHARS } from './wire-limits.js';
import { WIRE_MESSAGE_MAX_CHARS } from './wire-limits.js';

/**
 * Agent budget for `TASK: …` + inlined text blocks. Tighter than the chat cap
 * because the agent folds its system prompt + project context into the same
 * 32,000-char wire message on turn 1.
 */
export const AGENT_TASK_ATTACH_MAX_CHARS = 24_000;

/** Chat/agent model slugs that accept image input (mirrors server supportsVision). */
export const VISION_MODEL_SLUGS = ['hermes', 'minos'] as const;

export type AttachmentKind = 'image' | 'text';

/** A locally validated attachment, ready to upload (image) or inline (text). */
export interface LocalAttachment {
  /** Absolute path on disk. */
  absPath: string;
  /** Path shown in chips + used as the block header: relative to cwd when inside it. */
  displayPath: string;
  kind: AttachmentKind;
  sizeBytes: number;
  mime: string;
  /** Text attachments only: file content, already capped at TEXT_ATTACH_MAX_CHARS. */
  text?: string;
  /** True when `text` was cut at the cap (marker appended, warning shown). */
  truncated?: boolean;
}

/** Commander accumulator so `--attach` can repeat: --attach a.png --attach b.md */
export function collectAttachOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * The TUI's pending queue: `/attach` (and `--attach` seeds) feed EXACTLY the
 * next message. A send snapshots the queue, and consumes it only after the
 * uploads/pre-flight succeed - a failed send leaves everything queued, so no
 * attachment is ever silently dropped.
 */
export class PendingAttachments {
  private queue: LocalAttachment[];

  constructor(initial?: LocalAttachment[] | undefined) {
    this.queue = [...(initial ?? [])];
  }

  add(att: LocalAttachment): void {
    this.queue.push(att);
  }

  get size(): number {
    return this.queue.length;
  }

  hasImages(): boolean {
    return this.queue.some((a) => a.kind === 'image');
  }

  /** The attachments a send attempt will carry; the queue stays intact until consume(). */
  snapshot(): LocalAttachment[] {
    return [...this.queue];
  }

  /** Clear after a successful upload + send handoff - the message after this one gets nothing. */
  consume(): void {
    this.queue = [];
  }
}

export function isVisionModelSlug(slug: string): boolean {
  return (VISION_MODEL_SLUGS as readonly string[]).includes(slug.toLowerCase());
}

/** The vision-capable list rendered for errors - SpyCore display names only. */
function visionModelList(): string {
  return VISION_MODEL_SLUGS.map((s) => MODEL_DISPLAY[s]).join(', ');
}

/**
 * The actionable error for images attached to a non-vision model. Never
 * thrown for Hermes/Minos; names SpyCore models only.
 */
export function visionGateError(modelSlug: string): SpycoreCliError {
  const display =
    (MODEL_DISPLAY as Record<string, string>)[modelSlug.toLowerCase()] ?? modelSlug;
  return new SpycoreCliError(
    `${display} can't view images. Vision-capable models: ${visionModelList()}.`,
    EXIT_USER_ERROR,
    'Re-run with --model hermes or --model minos, or remove the image attachments.',
  );
}

/** NUL-byte sniff on the first 8 KiB - the standard "is this binary?" check. */
export function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8192);
  return window.includes(0);
}

function extOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** Relative-to-cwd display path; falls back to the basename when it escapes cwd. */
function toDisplayPath(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath);
  if (rel.length === 0) return basename(absPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return basename(absPath);
  return rel;
}

const SUPPORTED_KINDS_HINT =
  'Supported: images (.png, .jpg, .jpeg, .webp, .gif) and text files (source code, markdown, JSON, …).';

/**
 * Validate one attachment path: existence, readability, kind (image by
 * extension / text by content sniff), and the per-kind size caps. Throws a
 * clean SpycoreCliError on every failure - an attachment is never silently
 * skipped. Text content is read here (capped, marker on truncation).
 */
export function inspectAttachment(rawPath: string, cwd: string): LocalAttachment {
  const absPath = resolvePath(cwd, rawPath);
  if (!existsSync(absPath)) {
    throw new SpycoreCliError(`Attachment not found: ${rawPath}`, EXIT_USER_ERROR);
  }
  try {
    accessSync(absPath, constants.R_OK);
  } catch {
    throw new SpycoreCliError(
      `Cannot read attachment (permission denied): ${rawPath}`,
      EXIT_USER_ERROR,
    );
  }
  const st = statSync(absPath);
  if (!st.isFile()) {
    throw new SpycoreCliError(`Not a regular file: ${rawPath}`, EXIT_USER_ERROR);
  }
  if (st.size === 0) {
    throw new SpycoreCliError(`Attachment is empty: ${rawPath}`, EXIT_USER_ERROR);
  }

  const displayPath = toDisplayPath(absPath, cwd);
  const ext = extOf(absPath);

  if ((IMAGE_ATTACH_EXTS as readonly string[]).includes(ext)) {
    if (st.size > IMAGE_ATTACH_MAX_BYTES) {
      throw new SpycoreCliError(
        `Image is ${formatFileSize(st.size)} - the per-message image limit is ${formatFileSize(IMAGE_ATTACH_MAX_BYTES)}.`,
        EXIT_USER_ERROR,
        'Resize or compress the image and try again.',
      );
    }
    return {
      absPath,
      displayPath,
      kind: 'image',
      sizeBytes: st.size,
      mime: detectMime(absPath),
    };
  }

  // Not an image extension → candidate text file. Reject binaries cleanly
  // BEFORE reading the whole file; cap the read for the text path.
  // A file too large to ever fit the inline cap is rejected up front so we
  // never buffer hundreds of MB (4 bytes/char is the worst-case UTF-8 width).
  const maxReadBytes = TEXT_ATTACH_MAX_CHARS * 4;
  if (st.size > maxReadBytes) {
    throw new SpycoreCliError(
      `Attachment is ${formatFileSize(st.size)} - text attachments are capped at ${TEXT_ATTACH_MAX_CHARS} characters (~${formatFileSize(TEXT_ATTACH_MAX_CHARS)}).`,
      EXIT_USER_ERROR,
      'Attach a smaller file, or extract the relevant part into its own file.',
    );
  }
  const buf = readFileSync(absPath);
  if (looksBinary(buf)) {
    throw new SpycoreCliError(
      `Unsupported binary file: ${rawPath}`,
      EXIT_USER_ERROR,
      SUPPORTED_KINDS_HINT,
    );
  }
  let text = buf.toString('utf8');
  let truncated = false;
  if (text.length > TEXT_ATTACH_MAX_CHARS) {
    text = `${text.slice(0, TEXT_ATTACH_MAX_CHARS)}\n[attachment truncated at ${TEXT_ATTACH_MAX_CHARS} characters]`;
    truncated = true;
  }
  return {
    absPath,
    displayPath,
    kind: 'text',
    sizeBytes: st.size,
    mime: detectMime(absPath),
    text,
    truncated,
  };
}

/**
 * Validate a batch: every path inspected (first failure throws), image count
 * capped at the per-message limit with a clear error.
 */
export function inspectAttachments(paths: string[], cwd: string): LocalAttachment[] {
  const atts = paths.map((p) => inspectAttachment(p, cwd));
  const imageCount = atts.filter((a) => a.kind === 'image').length;
  if (imageCount > MAX_IMAGES_PER_MESSAGE) {
    throw new SpycoreCliError(
      `Too many images: ${imageCount} attached, the limit is ${MAX_IMAGES_PER_MESSAGE} per message.`,
      EXIT_USER_ERROR,
      'Split the images across multiple messages.',
    );
  }
  return atts;
}

/** One-line chip text for an attachment (caller sanitizes at the display boundary). */
export function attachmentChip(att: LocalAttachment): string {
  const kind = att.kind === 'image' ? 'image' : 'text';
  const trunc = att.truncated ? ', truncated' : '';
  return `${att.displayPath} (${kind}, ${formatFileSize(att.sizeBytes)}${trunc})`;
}

/**
 * Inline text attachments as delimited per-file blocks with a relative-path
 * header. User-owned content: no untrusted-content framing.
 */
export function buildTextAttachmentBlocks(atts: LocalAttachment[]): string {
  const blocks = atts
    .filter((a) => a.kind === 'text')
    .map(
      (a) =>
        `---- attached file: ${a.displayPath} ----\n${a.text ?? ''}\n---- end attached file: ${a.displayPath} ----`,
    );
  return blocks.join('\n\n');
}

/**
 * Assemble the outgoing chat message text: user text first, then the inlined
 * file blocks (mirroring how the web appends grounding context after the
 * user's words). Enforces the server's 32,000-char message cap with an
 * actionable error - nothing is silently trimmed or dropped.
 */
export function composeMessageWithAttachments(
  userText: string,
  atts: LocalAttachment[],
): string {
  const blocks = buildTextAttachmentBlocks(atts);
  const wire = blocks.length > 0 ? `${userText}\n\n[Attached files]\n${blocks}` : userText;
  return wire;
}

/**
 * Guard the final wire message (context injection included) against the
 * server's message cap. Only enforced client-side when attachments are in
 * play - the actionable fix (smaller/fewer files) belongs to this feature.
 */
export function assertWireMessageFits(wireMessage: string, textAttCount: number): void {
  if (textAttCount === 0) return;
  if (wireMessage.length <= WIRE_MESSAGE_MAX_CHARS) return;
  throw new SpycoreCliError(
    `Message is ${wireMessage.length} characters with attachments inlined - the limit is ${WIRE_MESSAGE_MAX_CHARS}.`,
    EXIT_USER_ERROR,
    'Attach fewer or smaller text files (each is capped at 24,000 characters), or shorten the message.',
  );
}

/**
 * Upload one image attachment through the existing files-upload plumbing
 * (multipart, category CHAT_IMAGE, bearer only to trusted hosts) and return
 * the server file record. Server-side plan/size/type errors surface through
 * uploadFile's existing clean error mapping.
 */
export async function uploadImageAttachment(
  att: LocalAttachment,
  opts: { apiUrlOverride?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<UploadResult> {
  const apiUrl = resolveApiUrl(opts.apiUrlOverride).replace(/\/+$/, '');
  // `apiUrl` already ends in `/api`; the route is `/api/files/upload`.
  const url = `${apiUrl}/files/upload`;
  const headers: Record<string, string> = {
    'user-agent': '@spycore/cli',
    accept: 'application/json',
  };
  // Bearer ONLY to trusted SpyCore hosts (+ localhost) - same exfil guard as
  // lib/api.ts / lib/sse.ts / the files upload command.
  if (isTrustedTokenHost(url)) {
    const token = await getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return uploadFile({
    path: att.absPath,
    url,
    headers,
    remoteName: basename(att.absPath),
    mime: att.mime,
    category: 'CHAT_IMAGE',
    signal: opts.signal,
  });
}

/**
 * Upload every image in the batch (sequentially - deterministic error order)
 * and return the server file IDs in input order. The first failure throws its
 * clean error; no attachment is ever silently skipped.
 */
export async function uploadImageAttachments(
  atts: LocalAttachment[],
  opts: { apiUrlOverride?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const att of atts) {
    if (att.kind !== 'image') continue;
    const result = await uploadImageAttachment(att, opts);
    ids.push(result.id);
  }
  return ids;
}

/**
 * Agent budget check: `TASK: …` + inlined blocks must leave room for the
 * system prompt + project context that share the same 32,000-char first-turn
 * message on the SpyCore provider.
 */
export function assertAgentTaskFits(task: string, attachedContext: string): void {
  if (attachedContext.length === 0) return;
  const total = task.length + attachedContext.length;
  if (total <= AGENT_TASK_ATTACH_MAX_CHARS) return;
  throw new SpycoreCliError(
    `Task plus attached text is ${total} characters - the agent limit is ${AGENT_TASK_ATTACH_MAX_CHARS}.`,
    EXIT_USER_ERROR,
    'Attach fewer or smaller text files - the agent can also read files itself with its read_file tool.',
  );
}
