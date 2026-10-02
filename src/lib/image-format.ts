/**
 * Pick the on-disk extension for a downloaded image from what we actually
 * received, not from a hard-coded guess.
 *
 * The image endpoint can return different raster encodings depending on the
 * model/pipeline, so a fixed `.png` name routinely lies about the bytes. We
 * resolve the real format in two steps:
 *
 *   1. Prefer the HTTP `Content-Type` when it names a known image encoding.
 *   2. Otherwise sniff the leading "magic" bytes of the payload.
 *
 * If neither is conclusive we fall back to `.png` — a wrong-but-openable
 * extension beats crashing on an empty/garbled response.
 */

export type ImageExtension = '.jpg' | '.png' | '.webp' | '.gif';

const DEFAULT_EXTENSION: ImageExtension = '.png';

/**
 * Map a normalized MIME subtype to an extension. Returns null for anything we
 * don't recognize so the caller can fall through to byte sniffing.
 */
function extensionForContentType(contentType: string): ImageExtension | null {
  const mime = contentType.toLowerCase().split(';')[0]!.trim();
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return null;
  }
}

/**
 * Detect an image format from its leading bytes. Covers the four encodings the
 * endpoint can plausibly emit. Returns null when nothing matches.
 */
function sniffMagicBytes(head: Buffer): ImageExtension | null {
  // JPEG — FF D8 FF
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return '.jpg';
  }
  // PNG — 89 50 4E 47
  if (
    head.length >= 4 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return '.png';
  }
  // WEBP — "RIFF" .... "WEBP"
  if (
    head.length >= 12 &&
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return '.webp';
  }
  // GIF — "GIF8" (covers GIF87a / GIF89a)
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'GIF8') {
    return '.gif';
  }
  return null;
}

/**
 * Choose the file extension (leading dot included) for an image given the
 * response Content-Type (preferred) and the payload's leading bytes (fallback).
 * Always returns a usable extension — never throws, never empty.
 *
 * @param contentType raw `Content-Type` header value (string, header array, or
 *   undefined — undici lower-cases header keys but values may be arrays).
 * @param head the first bytes of the body (may be empty).
 */
export function imageExtensionFor(
  contentType: string | string[] | undefined,
  head: Buffer,
): ImageExtension {
  const headerValue = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    const fromHeader = extensionForContentType(headerValue);
    if (fromHeader) return fromHeader;
  }
  return sniffMagicBytes(head) ?? DEFAULT_EXTENSION;
}
