/**
 * LSP (Language Server Protocol) integration — shared types.
 *
 * Everything here is plain data: no processes, no I/O, so it stays trivially
 * unit-testable. The wire framing lives in protocol.ts, the stdio client in
 * client.ts, the per-project opt-in in config.ts, and server lifecycle in
 * manager.ts.
 *
 * Line/column convention: the agent's existing diagnostics (see
 * `src/lib/agent/diagnostics.ts`) are 1-based. LSP ranges are 0-based, so the
 * client normalises to 1-based on the way in and this module documents that
 * once, here.
 */

/** Languages with a built-in server spec (manager.ts). */
export type LspLanguageId = 'typescript' | 'python' | 'go' | 'rust';

/**
 * LSP `DiagnosticSeverity` (1=Error, 2=Warning, 3=Information, 4=Hint)
 * normalised to names. Servers that omit severity are treated as `info` —
 * quieter than inventing an error.
 */
export type LspSeverity = 'error' | 'warning' | 'info' | 'hint';

export function mapLspSeverity(severity: number | undefined): LspSeverity {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'info';
  }
}

/**
 * One normalised diagnostic. `line`/`column` are 1-based (agent convention);
 * `file` is an absolute path.
 */
export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: LspSeverity;
  message: string;
  code?: string | number | undefined;
  source?: string | undefined;
}

/** A raw LSP diagnostic item as it arrives in `textDocument/publishDiagnostics`. */
export interface LspRawDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number | undefined;
  code?: string | number | undefined;
  source?: string | undefined;
  message: string;
}

/** Expected LSP failure (spawn error, handshake timeout, protocol error). */
export class LspError extends Error {}

/** Server lifecycle status. */
export type LspServerStatus = 'starting' | 'running' | 'error';

/**
 * Sidebar-ready status row. Field-for-field identical to the Wave-1 sidebar's
 * `LanguageServerInfo` (src/ui/tui/sidebar.tsx), so the TUI renders it with no
 * redesign — structural typing makes this assignable to that prop.
 */
export interface LanguageServerStatus {
  name: string;
  status: LspServerStatus;
  languages: string[];
}

/** Cap on formatted diagnostics lines (matches the tsc provider's 50). */
const FORMAT_CAP = 50;

/** Render diagnostics the way the agent's tsc provider does: `file:line:col [severity] message`. */
export function formatLspDiagnostics(diagnostics: readonly LspDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No diagnostics.';
  const lines = diagnostics.slice(0, FORMAT_CAP).map((d) => {
    const code = d.code !== undefined ? ` ${String(d.code)}` : '';
    const source = d.source ? ` (${d.source})` : '';
    return `${d.file}:${d.line}:${d.column} [${d.severity}]${code} ${d.message}${source}`;
  });
  if (diagnostics.length > FORMAT_CAP) {
    lines.push(`... and ${diagnostics.length - FORMAT_CAP} more`);
  }
  return lines.join('\n');
}
