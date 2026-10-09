/**
 * F18: dual-pane file picker dialog for the TUI.
 *
 * EXTENDS the @-mention completion - it does not replace it. The mention
 * flow (`activeMention` / `mentionSuggestions` in TuiApp) stays exactly as
 * it is: type `@`, get the inline sheet, Tab accepts the top file. This
 * picker is the ESCALATION for when the sheet is not enough:
 *
 *   WIRING (for the worker owning TuiApp.tsx): when a mention is active and
 *   the highlighted suggestion names a DIRECTORY (or the prefix ends with
 *   `/`), offer a key to open `FilePickerDialog` rooted at that directory
 *   (see the KEY CONTRACT below). Accepting a file inserts `@<relative path>`
 *   into the composer exactly like Tab-accepting a mention does, so the
 *   existing `resolveMentions` path handles it with zero changes. Esc closes
 *   the dialog and returns to the mention sheet.
 *
 * The LEFT pane is the Wave 1 picker grammar (`computePickerViewport` /
 * `PickerList` from picker-grammar.tsx): identical selection, scrolling and
 * scroll-rail behaviour to the command palette. The RIGHT pane is the live
 * preview of the highlighted entry - first N text lines, or a placeholder
 * for directories and binary files.
 *
 * KEY CONTRACT (TuiApp's single useInput implements these; this module is
 * presentational + pure state, the ChatInput idiom):
 *   up/down (or j/k)  move the highlight (`filePickerMove`)
 *   right / enter      descend into a directory, or PICK a file (`filePickerEnter`)
 *   left              go to the parent directory, clamped at the root (`filePickerUp`)
 *   typing            live substring filter (`filePickerSetFilter`)
 *   backspace         edit the filter (when non-empty) else go up
 *   escape            cancel (dialog returns to the mention sheet)
 *
 * SAFETY (mirrors the D4 @-mention policy): the picker is CONTAINED under
 * `root` (the TUI's cwd) - `filePickerUp` never escapes it and a start
 * directory outside it is clamped in. Dotfiles are hidden (the same
 * "never surface secrets" rule as `resolveMentions`). Symlinks are not
 * followed for preview.
 */
import { Box, Text } from 'ink';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { ReactNode } from 'react';
import {
  computePickerViewport,
  PickerList,
  type PickerRow,
} from './picker-grammar.js';
import type { Theme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

/** One row of the directory pane. */
export interface FilePickerEntry {
  /** Display name (`src/` for directories, `README.md` for files). */
  name: string;
  absPath: string;
  isDir: boolean;
  /** Bytes; 0 for directories. */
  size: number;
}

/** Live preview of the highlighted entry. */
export interface FilePreview {
  /** Sanitized preview lines, already truncated to the pane width. */
  lines: string[];
  /** True when the file continues past what is shown. */
  truncated: boolean;
  /** True for binary files and directories (no text preview). */
  binary: boolean;
  size: number;
}

/** Preview lines shown in the right pane. */
export const FILE_PICKER_PREVIEW_LINES = 24;
/** Bytes read for preview + binary sniffing (single bounded read). */
const FILE_PICKER_PREVIEW_BYTES = 64 * 1024;
/** Files larger than this are previewed as "[file too large to preview]". */
const FILE_PICKER_PREVIEW_MAX_FILE = 4 * 1024 * 1024;

/**
 * List one directory: directories first, then files, each alphabetical
 * (case-insensitive). Dotfiles are hidden (D4 parity). Unreadable entries
 * and broken symlinks are skipped silently - the picker degrades, never
 * throws, so a flaky directory can't take the TUI down.
 */
export function listDirectoryEntries(dir: string): FilePickerEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: FilePickerEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const absPath = join(dir, name);
    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      entries.push({ name: `${name}/`, absPath, isDir: true, size: 0 });
    } else if (st.isFile()) {
      entries.push({ name, absPath, isDir: false, size: st.size });
    }
  }
  const rank = (e: FilePickerEntry): number => (e.isDir ? 0 : 1);
  entries.sort(
    (a, b) => rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  return entries;
}

/** True when the buffer looks binary (NUL byte in the sniffed head). */
function isBinaryBuffer(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  return head.includes(0);
}

/**
 * Read the live preview for an entry. Directories report as binary (the
 * placeholder branch renders "N items"). Text files show the first
 * FILE_PICKER_PREVIEW_LINES lines; anything past that (or past
 * FILE_PICKER_PREVIEW_BYTES) sets `truncated`. Pure and bounded: one read,
 * capped bytes, never throws.
 */
export function readFilePreview(
  entry: FilePickerEntry,
  maxLines: number = FILE_PICKER_PREVIEW_LINES,
): FilePreview {
  if (entry.isDir) {
    let count = 0;
    try {
      count = readdirSync(entry.absPath).filter((n) => !n.startsWith('.')).length;
    } catch {
      count = 0;
    }
    return { lines: [`${count} item${count === 1 ? '' : 's'}`], truncated: false, binary: true, size: 0 };
  }
  if (entry.size > FILE_PICKER_PREVIEW_MAX_FILE) {
    return {
      lines: ['[file too large to preview]'],
      truncated: true,
      binary: false,
      size: entry.size,
    };
  }
  let buf: Buffer;
  try {
    const fd = readFileSync(entry.absPath);
    buf = fd.subarray(0, FILE_PICKER_PREVIEW_BYTES);
  } catch {
    return { lines: ['[unreadable]'], truncated: false, binary: true, size: entry.size };
  }
  if (isBinaryBuffer(buf)) {
    return {
      lines: ['[binary file - no preview]'],
      truncated: false,
      binary: true,
      size: entry.size,
    };
  }
  const text = buf.toString('utf8');
  const all = text.split('\n');
  const shown = all.slice(0, maxLines).map((l) => sanitizeForDisplay(l));
  return {
    lines: shown,
    truncated: all.length > maxLines || buf.length < entry.size,
    binary: false,
    size: entry.size,
  };
}

/** The picker's full UI state. Immutable updates via the pure helpers below. */
export interface FilePickerModel {
  /** Containment root (the TUI's cwd): navigation never leaves it. */
  root: string;
  /** Current directory (absolute, always under root). */
  dir: string;
  /** Filtered entries for `dir` (dirs-first, alphabetical). */
  entries: FilePickerEntry[];
  /** Highlight index into `entries`. */
  selected: number;
  /** Live preview of the highlighted entry (null when the list is empty). */
  preview: FilePreview | null;
  /** Substring filter typed by the user. */
  filter: string;
}

/** Clamp a directory under the containment root. */
function clampToRoot(root: string, dir: string): string {
  const rel = relative(root, dir);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))) return dir;
  return root;
}

function withSelection(model: FilePickerModel, selected: number): FilePickerModel {
  const entries = model.entries;
  const clamped = entries.length === 0 ? 0 : Math.min(Math.max(0, selected), entries.length - 1);
  const current = entries[clamped] ?? null;
  return {
    ...model,
    selected: clamped,
    preview: current ? readFilePreview(current) : null,
  };
}

function applyFilter(model: FilePickerModel, filter: string): FilePickerModel {
  const all = listDirectoryEntries(model.dir);
  const q = filter.toLowerCase();
  const entries = q.length === 0 ? all : all.filter((e) => e.name.toLowerCase().includes(q));
  return withSelection({ ...model, filter, entries }, 0);
}

/** Open the picker at `startDir` (clamped under `rootDir`). */
export function createFilePickerModel(rootDir: string, startDir?: string): FilePickerModel {
  const root = resolve(rootDir);
  const dir = clampToRoot(root, startDir ? resolve(startDir) : root);
  const entries = listDirectoryEntries(dir);
  const model: FilePickerModel = { root, dir, entries, selected: 0, preview: null, filter: '' };
  return withSelection(model, 0);
}

/** Move the highlight by `delta` rows (clamped; no wrap). */
export function filePickerMove(model: FilePickerModel, delta: number): FilePickerModel {
  return withSelection(model, model.selected + delta);
}

/** Replace the live filter; resets the highlight to the top. */
export function filePickerSetFilter(model: FilePickerModel, filter: string): FilePickerModel {
  return applyFilter(model, filter);
}

export interface FilePickerEnterResult {
  model: FilePickerModel;
  /**
   * Absolute path of the picked FILE, or null when Enter descended into a
   * directory instead. The caller inserts `@<relative-to-cwd>` into the
   * composer for a picked file - exactly like a Tab-accepted @-mention.
   */
  picked: string | null;
}

/**
 * Enter on the highlight: directories descend (filter cleared), files are
 * picked. Pure - the caller owns the composer insert + dialog close.
 */
export function filePickerEnter(model: FilePickerModel): FilePickerEnterResult {
  const entry = model.entries[model.selected] ?? null;
  if (!entry) return { model, picked: null };
  if (entry.isDir) {
    const next: FilePickerModel = {
      ...model,
      dir: entry.absPath,
      filter: '',
      entries: listDirectoryEntries(entry.absPath),
    };
    return { model: withSelection(next, 0), picked: null };
  }
  return { model, picked: entry.absPath };
}

/** Up one directory; clamped at the containment root (never escapes). */
export function filePickerUp(model: FilePickerModel): FilePickerModel {
  if (model.dir === model.root) return model;
  const parent = resolve(model.dir, '..');
  const dir = clampToRoot(model.root, parent);
  const next: FilePickerModel = {
    ...model,
    dir,
    filter: '',
    entries: listDirectoryEntries(dir),
  };
  // Keep the highlight on the directory we just came from, when visible.
  const cameFrom = basename(model.dir);
  const idx = next.entries.findIndex((e) => e.isDir && e.name === `${cameFrom}/`);
  return withSelection(next, idx >= 0 ? idx : 0);
}

export interface FilePickerDialogProps {
  model: FilePickerModel;
  theme: Theme;
  /** Total dialog width in cells. */
  width: number;
  /** Total dialog height in rows (header + panes + footer). */
  height: number;
  /** Dim hint rendered in the footer (the key contract, usually). */
  hint?: string | undefined;
}

/** Code-point-aware truncation that never splits a surrogate pair. */
function fitLine(s: string, maxWidth: number): string {
  const cps = [...s];
  return cps.length > maxWidth ? `${cps.slice(0, Math.max(0, maxWidth - 1)).join('')}…` : s;
}

/**
 * The dual-pane dialog. Presentational: renders `model`, owns no keys (see
 * the KEY CONTRACT in the module docstring - TuiApp's useInput drives the
 * pure helpers above). Left pane is the Wave 1 `PickerList`; right pane is
 * the live preview. Fixed height in every state so the TUI never jumps.
 */
export function FilePickerDialog({
  model,
  theme,
  width,
  height,
  hint,
}: FilePickerDialogProps): ReactNode {
  const { colors } = theme;
  const w = Math.max(40, width);
  const h = Math.max(8, height);
  // Header (1) + footer (2: breadcrumb + hint) = 3 chrome rows.
  const listRows = Math.max(3, h - 3);
  const leftWidth = Math.max(20, Math.floor(w * 0.42));
  const rightWidth = Math.max(16, w - leftWidth - 3); // -3: gap + preview border

  const rows: PickerRow[] = model.entries.map((e) => ({ key: e.absPath, text: e.name }));
  const viewport = computePickerViewport(rows, model.selected, listRows);

  const rel = relative(model.root, model.dir);
  const breadcrumb = rel === '' ? '.' : `./${rel}`;
  const preview = model.preview;
  const previewTitle = model.entries[model.selected]?.name ?? '';

  return (
    <Box flexDirection="column" width={w} height={h}>
      {/* Header: current directory. */}
      <Box width="100%">
        <Text color={colors.accent} bold>
          {fitLine(`▸ ${breadcrumb}/`, w)}
        </Text>
      </Box>
      {/* Panes. */}
      <Box flexDirection="row" width="100%" height={listRows}>
        <Box width={leftWidth} flexDirection="column">
          <PickerList
            viewport={viewport}
            theme={theme}
            width={leftWidth}
            emptyText={model.filter ? 'No matches' : 'Empty directory'}
          />
        </Box>
        <Box width={1} />
        <Box
          flexDirection="column"
          width={rightWidth}
          borderStyle={theme.borderStyle}
          borderColor={colors.borderSubtle}
          paddingX={1}
        >
          <Text color={colors.textDim} bold>
            {fitLine(previewTitle, rightWidth - 2)}
          </Text>
          {preview === null ? (
            <Text color={colors.muted}>Nothing to preview</Text>
          ) : preview.binary ? (
            <Text color={colors.muted}>{preview.lines[0] ?? ''}</Text>
          ) : (
            <>
              {preview.lines.map((l, i) => (
                <Text key={i} color={colors.textDim}>
                  {fitLine(l.length === 0 ? ' ' : l, rightWidth - 2)}
                </Text>
              ))}
              {preview.truncated && <Text color={colors.muted}>… truncated</Text>}
            </>
          )}
        </Box>
      </Box>
      {/* Footer: filter + hint. */}
      <Box width="100%">
        <Text color={colors.muted}>
          {fitLine(
            model.filter.length > 0 ? `Filter: ${model.filter}` : (hint ?? '↑↓ move · → open · ← up · type to filter · esc cancel'),
            w,
          )}
        </Text>
      </Box>
    </Box>
  );
}
