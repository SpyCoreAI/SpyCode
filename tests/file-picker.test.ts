import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createFilePickerModel,
  filePickerEnter,
  filePickerMove,
  filePickerSetFilter,
  filePickerUp,
  listDirectoryEntries,
  readFilePreview,
} from '../src/ui/tui/file-picker.js';

/**
 * F18: the dual-pane picker is pure state + a presentational component, so
 * the state machine is pinned here without Ink. The component itself renders
 * through the Wave 1 picker grammar (covered by its own tests).
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'spycode-filepicker-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'README.md'), '# hello\nline2\nline3\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, '.env'), 'SECRET=shhh\n'); // dotfile: hidden
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  let big = '';
  for (let i = 0; i < 200; i++) big += `line ${i}\n`;
  writeFileSync(join(root, 'big.txt'), big);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listDirectoryEntries', () => {
  test('dirs first, then files, alphabetical; dotfiles hidden', () => {
    const names = listDirectoryEntries(root).map((e) => e.name);
    expect(names).toEqual(['docs/', 'src/', 'big.txt', 'blob.bin', 'README.md']);
    expect(names).not.toContain('.env');
  });

  test('unreadable directory degrades to empty, never throws', () => {
    expect(listDirectoryEntries(join(root, 'nope'))).toEqual([]);
  });
});

describe('readFilePreview', () => {
  test('text file shows lines, not truncated', () => {
    const entry = listDirectoryEntries(root).find((e) => e.name === 'README.md')!;
    const p = readFilePreview(entry, 24);
    expect(p.binary).toBe(false);
    expect(p.truncated).toBe(false);
    expect(p.lines[0]).toBe('# hello');
  });

  test('long file truncates at maxLines', () => {
    const entry = listDirectoryEntries(root).find((e) => e.name === 'big.txt')!;
    const p = readFilePreview(entry, 24);
    expect(p.lines).toHaveLength(24);
    expect(p.truncated).toBe(true);
  });

  test('binary file reports binary with a placeholder', () => {
    const entry = listDirectoryEntries(root).find((e) => e.name === 'blob.bin')!;
    const p = readFilePreview(entry);
    expect(p.binary).toBe(true);
    expect(p.lines[0]).toMatch(/binary/);
  });

  test('directory previews as an item count', () => {
    const entry = listDirectoryEntries(root).find((e) => e.name === 'src/')!;
    const p = readFilePreview(entry);
    expect(p.binary).toBe(true);
    expect(p.lines[0]).toBe('1 item');
  });
});

describe('picker state machine', () => {
  test('createFilePickerModel roots at the given dir with a live preview', () => {
    const m = createFilePickerModel(root);
    expect(m.root).toBe(root);
    expect(m.dir).toBe(root);
    expect(m.selected).toBe(0);
    expect(m.preview).not.toBeNull();
    // First entry is docs/ (dirs first) -> directory preview.
    expect(m.preview!.binary).toBe(true);
  });

  test('a start dir outside the root is clamped to the root (containment)', () => {
    const m = createFilePickerModel(root, tmpdir());
    expect(m.dir).toBe(m.root);
  });

  test('filePickerMove clamps at the edges (no wrap)', () => {
    let m = createFilePickerModel(root);
    m = filePickerMove(m, -5);
    expect(m.selected).toBe(0);
    m = filePickerMove(m, 999);
    expect(m.selected).toBe(m.entries.length - 1);
  });

  test('filePickerEnter descends into directories, picks files', () => {
    let m = createFilePickerModel(root);
    // docs/ is first; make it selected and enter -> descend.
    const docsIdx = m.entries.findIndex((e) => e.name === 'docs/');
    m = filePickerMove(m, docsIdx);
    const descended = filePickerEnter(m);
    expect(descended.picked).toBeNull();
    expect(descended.model.dir).toBe(join(root, 'docs'));
    expect(descended.model.filter).toBe('');

    // Enter on a file picks its absolute path.
    let m2 = createFilePickerModel(root);
    const readmeIdx = m2.entries.findIndex((e) => e.name === 'README.md');
    m2 = filePickerMove(m2, readmeIdx);
    const picked = filePickerEnter(m2);
    expect(picked.picked).toBe(join(root, 'README.md'));
  });

  test('filePickerUp never escapes the containment root', () => {
    const m = createFilePickerModel(root);
    const srcIdx = m.entries.findIndex((e) => e.name === 'src/');
    const descended = filePickerEnter({ ...m, selected: srcIdx });
    expect(descended.model.dir).toBe(join(root, 'src'));
    const up = filePickerUp(descended.model);
    expect(up.dir).toBe(root);
    // At root, up is a no-op.
    expect(filePickerUp(up).dir).toBe(root);
  });

  test('filePickerUp re-highlights the directory we came from', () => {
    const m = createFilePickerModel(root);
    const descended = filePickerEnter({ ...m, selected: m.entries.findIndex((e) => e.name === 'src/') });
    const up = filePickerUp(descended.model);
    expect(up.entries[up.selected]!.name).toBe('src/');
  });

  test('filePickerSetFilter narrows entries and resets selection', () => {
    let m = createFilePickerModel(root);
    m = filePickerMove(m, 3);
    m = filePickerSetFilter(m, 'read');
    expect(m.entries.map((e) => e.name)).toEqual(['README.md']);
    expect(m.selected).toBe(0);
    expect(m.preview!.lines[0]).toBe('# hello');
    m = filePickerSetFilter(m, '');
    expect(m.entries.length).toBe(5);
  });
});
