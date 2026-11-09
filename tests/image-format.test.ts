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

describe('imageExtensionFor AVIF', () => {
  test('prefers an AVIF Content-Type', () => {
    const empty = Buffer.alloc(0);
    expect(imageExtensionFor('image/avif', empty)).toBe('.avif');
    expect(imageExtensionFor('Image/AVIF; charset=binary', empty)).toBe('.avif');
  });

  test('sniffs AVIF ftyp magic bytes (avif and avis brands)', () => {
    const avif = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('avif'),
      Buffer.from([0x00]),
    ]);
    const avis = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('avis'),
      Buffer.from([0x00]),
    ]);
    expect(imageExtensionFor(undefined, avif)).toBe('.avif');
    expect(imageExtensionFor(undefined, avis)).toBe('.avif');
    // An ftyp box with another brand is not AVIF.
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('isom'),
    ]);
    expect(imageExtensionFor(undefined, mp4)).toBe('.png');
  });
});
