import { lookup as mimeLookup } from 'mime-types';
import { extname } from 'node:path';

/**
 * Detect MIME type from file extension. Falls back to
 * application/octet-stream when the type isn't recognised.
 */
export function detectMime(filename: string): string {
  const guessed = mimeLookup(filename);
  if (typeof guessed === 'string') return guessed;
  return 'application/octet-stream';
}

/** Format file size in human-readable form (1.2 MB). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // Drop the decimal once we cross 100 in the chosen unit so the column
  // stays narrow ("1.2 MB" vs "123 MB").
  const formatted = v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${formatted} ${units[i]}`;
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
]);

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
]);

/** Determine if file is text (for terminal preview). */
export function isTextMime(mime: string): boolean {
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  return TEXT_MIMES.has(mime);
}

/** Determine if file is an image. */
export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/**
 * Pick a short human label for a mime type so the list view's "Type"
 * column doesn't end up with "application/vnd.…" verbosity.
 */
export function shortMimeLabel(mime: string, filename?: string): string {
  if (!mime) return 'file';
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'application/json') return 'JSON';
  if (mime === 'text/markdown') return 'MD';
  if (mime === 'text/csv') return 'CSV';
  if (mime.startsWith('image/')) return mime.slice('image/'.length).toUpperCase();
  if (mime.startsWith('text/')) {
    const ext = filename ? extname(filename).replace(/^\./, '').toUpperCase() : '';
    if (ext) return ext;
    return 'TEXT';
  }
  // Last resort: extract the subtype, upper-cased and clipped.
  const sub = mime.split('/')[1] ?? mime;
  return sub.slice(0, 8).toUpperCase();
}

/**
 * Format an ISO timestamp as a short relative description ("2 days ago").
 * Mirrors the conversations list to keep the UX consistent.
 */
export function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / (86400 * 7))}w ago`;
  if (diffSec < 86400 * 365) return `${Math.floor(diffSec / (86400 * 30))}mo ago`;
  return `${Math.floor(diffSec / (86400 * 365))}y ago`;
}

/**
 * Bucket a list of items with a date field into Today / Yesterday /
 * Last week / Earlier groups so the list view can subhead them.
 */
export function bucketByRecency<T extends { createdAt: string }>(
  items: T[],
): Array<{ label: string; items: T[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeek = startOfToday - 7 * 86_400_000;

  const today: T[] = [];
  const yesterday: T[] = [];
  const lastWeek: T[] = [];
  const earlier: T[] = [];
  for (const item of items) {
    const ts = Date.parse(item.createdAt);
    if (Number.isNaN(ts)) {
      earlier.push(item);
      continue;
    }
    if (ts >= startOfToday) today.push(item);
    else if (ts >= startOfYesterday) yesterday.push(item);
    else if (ts >= startOfWeek) lastWeek.push(item);
    else earlier.push(item);
  }
  const result: Array<{ label: string; items: T[] }> = [];
  if (today.length > 0) result.push({ label: 'Today', items: today });
  if (yesterday.length > 0) result.push({ label: 'Yesterday', items: yesterday });
  if (lastWeek.length > 0) result.push({ label: 'Last week', items: lastWeek });
  if (earlier.length > 0) result.push({ label: 'Earlier', items: earlier });
  return result;
}
