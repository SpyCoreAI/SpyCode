import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';
import { afterAll, describe, expect, test } from 'vitest';
import { createFilePickerModel, FilePickerDialog } from '../src/ui/tui/file-picker.js';
import { resolveTheme } from '../src/ui/theme/theme.js';
import { detectCapabilities } from '../src/ui/theme/capabilities.js';

let root: string;
root = mkdtempSync(join(tmpdir(), 'spycode-fp-render-'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'README.md'), '# hello\nline2\n');
writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1;\n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('FilePickerDialog render', () => {
  test('renders without crashing and shows both panes', () => {
    const theme = resolveTheme(detectCapabilities(), 'dark');
    const model = createFilePickerModel(root);
    let out = '';
    const fakeStdout = {
      write: (s: string): boolean => {
        out += s;
        return true;
      },
      columns: 80,
      rows: 24,
    } as unknown as NodeJS.WriteStream;
    const inst = render(
      React.createElement(FilePickerDialog, { model, theme, width: 80, height: 20 }),
      { stdout: fakeStdout, debug: true },
    );
    inst.unmount();
    const frame = out.replace(/\u001b\[[0-9;]*m/g, '');
    // Left pane: directory listing; right pane: live preview of the
    // highlighted entry (src/ -> "1 item").
    expect(frame).toContain('README.md');
    expect(frame).toContain('src/');
    expect(frame).toContain('1 item');
    expect(frame).toContain('↑↓ move');
  });
});
