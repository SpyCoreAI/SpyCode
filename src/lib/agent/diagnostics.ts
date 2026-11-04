/**
 * Diagnostics via the project's language servers (LSP).
 *
 * Previously this shelled out to `npx tsc --noEmit` (slow: a cold compiler
 * run with a 60s timeout on every call). It now goes through the LSP
 * manager's warm, on-demand servers instead: no subprocess per call, bounded
 * waits, and the same per-project opt-in gate as the `diagnostics` tool.
 *
 * Without `./.spycore/lsp.json` containing `{"enabled": true}` (or
 * `SPYCODE_LSP=1`) this reports that LSP is not enabled rather than spawning
 * anything - starting a language server is a long-lived child process and
 * stays opt-in.
 *
 * Contract: TypeScript/JavaScript files only (the typescript server's
 * extensions), errors and warnings only (info/hint have no `Diagnostic`
 * representation - the tsc provider never produced them either).
 */

import { extname } from 'node:path';
import {
  getLspManager,
  isLspEnabled,
  LANGUAGE_SPECS,
  type LspDiagnostic,
} from './lsp/index.js';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  code: number;
}

export type DiagnosticsResult =
  | { ok: true; diagnostics: Diagnostic[] }
  | { ok: false; reason: string };

const TS_EXTENSIONS: ReadonlySet<string> = new Set(
  LANGUAGE_SPECS.typescript.extensions,
);

/** LSP diagnostic → the tsc-shaped Diagnostic; null for severities with no representation. */
function toDiagnostic(d: LspDiagnostic): Diagnostic | null {
  if (d.severity !== 'error' && d.severity !== 'warning') return null;
  const code =
    typeof d.code === 'number'
      ? d.code
      : typeof d.code === 'string'
        ? parseInt(d.code, 10) || 0
        : 0;
  return {
    file: d.file,
    line: d.line,
    column: d.column,
    severity: d.severity,
    message: d.message,
    code,
  };
}

/**
 * TypeScript/JavaScript diagnostics for the workspace, via LSP.
 * Returns `{ ok: false }` when LSP is not enabled or the TypeScript server
 * cannot start - never throws.
 */
export async function getTypeScriptDiagnostics(cwd: string): Promise<DiagnosticsResult> {
  try {
    if (!isLspEnabled(cwd)) {
      return {
        ok: false,
        reason:
          'LSP diagnostics are not enabled for this project. ' +
          'Create .spycore/lsp.json in the project root with { "enabled": true } ' +
          '(and trust the workspace) to opt in.',
      };
    }
    const manager = getLspManager(cwd);
    const { diagnostics, skipped } = await manager.workspaceDiagnostics();
    const tsSkipped = skipped.find((s) => s.language === 'typescript');
    if (tsSkipped) {
      return { ok: false, reason: `TypeScript language server unavailable: ${tsSkipped.reason}` };
    }
    const out: Diagnostic[] = [];
    for (const d of diagnostics) {
      if (!TS_EXTENSIONS.has(extname(d.file).toLowerCase())) continue;
      const conv = toDiagnostic(d);
      if (conv) out.push(conv);
    }
    out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    return { ok: true, diagnostics: out };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function formatDiagnostics(result: DiagnosticsResult): string {
  if (!result.ok) {
    return `Diagnostic check failed: ${result.reason}`;
  }
  const diags = result.diagnostics;
  if (diags.length === 0) return 'No TypeScript errors.';
  const lines = diags.slice(0, 50).map(
    (d) => `${d.file}:${d.line}:${d.column} [TS${d.code}] ${d.message}`,
  );
  if (diags.length > 50) {
    lines.push(`... and ${diags.length - 50} more`);
  }
  return lines.join('\n');
}
