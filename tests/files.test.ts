import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketByRecency,
  createExclusiveTempWriteStream,
  detectMime,
  formatFileSize,
  isImageMime,
  isTextMime,
  relativeTime,
  shortMimeLabel,
} from '../src/lib/files.js';

describe('detectMime', () => {
  test('guesses from the extension, falls back to octet-stream', () => {
    expect(detectMime('photo.png')).toBe('image/png');
    expect(detectMime('doc.pdf')).toBe('application/pdf');
    expect(detectMime('ARCHIVE.ZIP')).toBe('application/zip');
    expect(detectMime('no-extension-here')).toBe('application/octet-stream');
    expect(detectMime('weird.unknownextxyz')).toBe('application/octet-stream');
  });
});

describe('formatFileSize', () => {
  test('bytes under 1 KiB', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  test('KiB/MB with one decimal, dropped past 100', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(123 * 1024 * 1024)).toBe('123 MB');
    expect(formatFileSize(2 * 1024 ** 3)).toBe('2.0 GB');
  });

  test('garbage in → "?" out', () => {
    expect(formatFileSize(-1)).toBe('?');
    expect(formatFileSize(NaN)).toBe('?');
    expect(formatFileSize(Infinity)).toBe('?');
  });
});

describe('isTextMime / isImageMime', () => {
  test('text/ prefix and the known text-ish application types', () => {
    expect(isTextMime('text/plain')).toBe(true);
    expect(isTextMime('text/markdown')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('application/xml')).toBe(true);
    expect(isTextMime('application/javascript')).toBe(true);
    expect(isTextMime('')).toBe(false);
    expect(isTextMime('image/png')).toBe(false);
    expect(isTextMime('application/pdf')).toBe(false);
  });

  test('the image set', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']) {
      expect(isImageMime(m)).toBe(true);
    }
    expect(isImageMime('image/tiff')).toBe(false);
    expect(isImageMime('text/plain')).toBe(false);
  });
});

describe('shortMimeLabel', () => {
  test('special cases', () => {
    expect(shortMimeLabel('')).toBe('file');
    expect(shortMimeLabel('application/pdf')).toBe('PDF');
    expect(shortMimeLabel('application/json')).toBe('JSON');
    expect(shortMimeLabel('text/markdown')).toBe('MD');
    expect(shortMimeLabel('text/csv')).toBe('CSV');
  });

  test('images use the subtype', () => {
    expect(shortMimeLabel('image/png')).toBe('PNG');
    expect(shortMimeLabel('image/svg+xml')).toBe('SVG+XML');
  });

  test('other text types use the filename extension, else TEXT', () => {
    expect(shortMimeLabel('text/plain', 'app.ts')).toBe('TS');
    expect(shortMimeLabel('text/plain')).toBe('TEXT');
  });

  test('last resort: upper-cased subtype, clipped to 8 chars', () => {
    expect(shortMimeLabel('application/vnd.ms-excel')).toBe('VND.MS-E');
    expect(shortMimeLabel('application/zip')).toBe('ZIP');
  });
});

describe('relativeTime', () => {
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  test('invalid input → empty string', () => {
    expect(relativeTime('not a date')).toBe('');
    expect(relativeTime('')).toBe('');
  });

  test('seconds, minutes, hours', () => {
    expect(relativeTime(ago(5_000))).toBe('5s ago');
    expect(relativeTime(ago(90_000))).toBe('1m ago');
    expect(relativeTime(ago(2 * 3_600_000))).toBe('2h ago');
  });

  test('days, weeks, months, years', () => {
    expect(relativeTime(ago(3 * 86_400_000))).toBe('3d ago');
    expect(relativeTime(ago(10 * 86_400_000))).toBe('1w ago');
    expect(relativeTime(ago(60 * 86_400_000))).toBe('2mo ago');
    expect(relativeTime(ago(400 * 86_400_000))).toBe('1y ago');
  });
});

describe('bucketByRecency', () => {
  const item = (createdAt: string, id: string): { createdAt: string; id: string } => ({ createdAt, id });
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  test('empty input → no buckets', () => {
    expect(bucketByRecency([])).toEqual([]);
  });

  test('buckets by recency in fixed order', () => {
    // Yesterday at noon: always inside the calendar-day "Yesterday" bucket
    // regardless of the time of day the test runs (a fixed 26h offset can
    // cross midnight into the day before yesterday when run after 02:00).
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const yesterdayNoon = new Date(startOfToday.getTime() - 12 * 3_600_000).toISOString();
    const out = bucketByRecency([
      item(ago(40 * 86_400_000), 'earlier'),
      item(ago(10_000), 'today'),
      item(yesterdayNoon, 'yesterday'),
      item(ago(3 * 86_400_000), 'week'),
    ]);
    expect(out.map((b) => b.label)).toEqual(['Today', 'Yesterday', 'Last week', 'Earlier']);
    expect(out[0]!.items.map((i) => i.id)).toEqual(['today']);
  });

  test('unparseable dates land in Earlier', () => {
    const out = bucketByRecency([item('garbage', 'x')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('Earlier');
  });
});

describe('createExclusiveTempWriteStream', () => {
  test('creates a 0600 file and returns a working stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spy-tmpws-'));
    try {
      const { stream, path } = createExclusiveTempWriteStream(dir, 'up');
      expect(path).toBe(join(dir, 'up'));
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.end('hello', () => resolve());
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('EEXIST retries with a random suffix instead of clobbering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spy-tmpws-'));
    try {
      writeFileSync(join(dir, 'up'), 'stale');
      const { stream, path } = createExclusiveTempWriteStream(dir, 'up');
      expect(path).not.toBe(join(dir, 'up'));
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.end('fresh', () => resolve());
      });
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(join(dir, 'up'), 'utf-8')).toBe('stale'); // untouched
      expect(readFileSync(path, 'utf-8')).toBe('fresh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
