import { describe, expect, test } from 'vitest';
import { imageExtensionFor } from '../src/lib/image-format.js';

describe('imageExtensionFor', () => {
  test('prefers a known Content-Type', () => {
    const empty = Buffer.alloc(0);
    expect(imageExtensionFor('image/jpeg', empty)).toBe('.jpg');
    expect(imageExtensionFor('image/jpg', empty)).toBe('.jpg');
    expect(imageExtensionFor('image/png', empty)).toBe('.png');
    expect(imageExtensionFor('image/webp', empty)).toBe('.webp');
    expect(imageExtensionFor('image/gif', empty)).toBe('.gif');
  });

  test('normalizes Content-Type casing and parameters', () => {
    const empty = Buffer.alloc(0);
    expect(imageExtensionFor('Image/JPEG; charset=binary', empty)).toBe('.jpg');
    expect(imageExtensionFor('  image/webp ', empty)).toBe('.webp');
    // undici can surface a header as an array
    expect(imageExtensionFor(['image/png'], empty)).toBe('.png');
  });

  test('sniffs the magic bytes when Content-Type is missing', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
      Buffer.from([0x00]),
    ]);
    const gif87 = Buffer.from('GIF87a');
    const gif89 = Buffer.from('GIF89a');
    expect(imageExtensionFor(undefined, jpeg)).toBe('.jpg');
    expect(imageExtensionFor(undefined, png)).toBe('.png');
    expect(imageExtensionFor(undefined, webp)).toBe('.webp');
    expect(imageExtensionFor(undefined, gif87)).toBe('.gif');
    expect(imageExtensionFor(undefined, gif89)).toBe('.gif');
  });

  test('falls through to a byte sniff when Content-Type is unhelpful', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(imageExtensionFor('application/octet-stream', jpeg)).toBe('.jpg');
    expect(imageExtensionFor('', jpeg)).toBe('.jpg');
  });

  test('Content-Type wins over conflicting magic bytes', () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff]);
    expect(imageExtensionFor('image/png', jpegBytes)).toBe('.png');
  });

  test('falls back to .png when nothing is detectable', () => {
    expect(imageExtensionFor(undefined, Buffer.alloc(0))).toBe('.png');
    expect(imageExtensionFor('application/octet-stream', Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(
      '.png',
    );
    expect(imageExtensionFor(undefined, Buffer.from([0x42]))).toBe('.png');
  });
});
