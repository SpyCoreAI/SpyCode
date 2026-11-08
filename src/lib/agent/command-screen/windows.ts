/**
 * Windows-native catastrophic-command screen.
 *
 * `runShellCommand` spawns with `shell: true`, which is `cmd.exe` on
 * Windows - but the POSIX screen in `engine.ts` models `/bin/sh` grammar
 * only, so native Windows destructive commands (`rd /s /q`, `del /s`,
 * `format`, `reg delete`, …) were never screened at all. This module is
 * the cmd.exe counterpart: it reads the same property - "which word is the
 * command, and what are its operands?" - over cmd.exe tokenization
 * (`&`/`|`/`&&`/`||` separators, `^` escapes, double-quoted words) rather
 * than POSIX parsing.
 *
 * It runs on EVERY platform, inside `matchesCatastrophic`, next to the
 * POSIX screen: a Windows destructive form is destructive wherever it is
 * typed, and the screen is the only control on `run_command` (exempt from
 * the secret guard and the sandbox). The heads it names are not POSIX
 * commands, so the benign POSIX corpus is unaffected - `del`, `rd`,
 * `format`, `reg`, `diskpart`, `cipher`, `vssadmin` and `bcdedit` as a
 * command head have no ordinary POSIX use.
 *
 * Deliberately not exhaustive: `%VAR%` expansion, `start` indirection and
 * encoded payloads are out of scope, exactly as `$IFS` splicing is for the
 * POSIX screen. The approval prompt remains the primary control.
 */

/** Command heads that delete recursively - blocked only with the `/s` flag. */
const RECURSIVE_DELETE_HEADS = new Set(['rd', 'rmdir', 'del', 'erase']);

/** Heads blocked on any invocation: no benign spelling exists. */
const ALWAYS_BLOCK_HEADS = new Set(['format', 'diskpart']);

/** `reg` sub-commands that destroy. */
const REG_DELETE = new Set(['delete']);

/** `bcdedit` options that destroy or rewrite boot configuration. */
const BCDEDIT_DESTRUCTIVE = new Set(['/delete', '/set', '/default']);

/** PowerShell verbs that destroy, inside a `powershell -c` payload. */
const PS_RECURSIVE_HEADS = new Set([
  'remove-item',
  'rm',
  'ri',
  'del',
  'erase',
  'rd',
  'rmdir',
]);
const PS_ALWAYS_BLOCK_HEADS = new Set(['format-volume', 'clear-recyclebin']);

/** Flags spelling a cmd.exe extension (`.exe`, `.cmd`, `.bat`, `.com`). */
const CMD_EXTENSION = /\.(?:exe|cmd|bat|com)$/i;

/** Split a cmd.exe line into `&`/`|`-separated segments, honouring quotes. */
function splitCmdSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && (ch === '&' || ch === '|')) {
      segments.push(current);
      // `&&` / `||` are one separator, not two.
      if (command[i + 1] === ch) i += 1;
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

/** Tokenize one cmd.exe segment: `^` escapes the next char, quotes group. */
function tokenizeCmd(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string;
    if (ch === '^' && !inQuotes) {
      // A caret escapes the next character - keep the character, drop the caret.
      if (i + 1 < segment.length) {
        current += segment[i + 1] as string;
        hasToken = true;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** The command head: basename, extension stripped, lower-cased. */
function cmdHead(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(CMD_EXTENSION, '').toLowerCase();
}

/** A cmd.exe flag, case-insensitively (`/S` is `/s`). */
function isFlag(arg: string, flag: string): boolean {
  return arg.toLowerCase() === flag;
}

/** Screen one PowerShell `-c` payload for destructive verbs. */
function screenPowerShellPayload(payload: string): string | null {
  const winHit = screenWindowsCommand(payload);
  if (winHit) return winHit;
  // PowerShell tokenization is whitespace + quotes; commas, semicolons and
  // pipes separate statements/stages but never hide the head word. Scan
  // EVERY token as a candidate head - a destructive verb can sit behind a
  // pipe (`Get-ChildItem | Remove-Item -Recurse`) or a call operator
  // (`& { Remove-Item -Recurse … }`) - and only the tokens up to the next
  // destructive head count as its arguments.
  const tokens = payload
    .split(/[\s;,|]+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const head = (tokens[i] as string).toLowerCase();
    if (PS_ALWAYS_BLOCK_HEADS.has(head)) return `${head} (destructive PowerShell command)`;
    if (!PS_RECURSIVE_HEADS.has(head)) continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const arg = (tokens[j] as string).toLowerCase();
      if (PS_RECURSIVE_HEADS.has(arg) || PS_ALWAYS_BLOCK_HEADS.has(arg)) break;
      if (/^-rec/.test(arg)) return `${head} -Recurse (recursive delete via PowerShell)`;
    }
  }
  return null;
}

function screenCmdSegment(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const head = cmdHead(tokens[0] as string);
  const args = tokens.slice(1);

  // `cmd /c <payload>` / `cmd /k <payload>` - the payload is another command.
  if (head === 'cmd') {
    const ci = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (ci >= 0) {
      const payload = args.slice(ci + 1).join(' ');
      if (payload.length > 0) return screenWindowsCommand(payload);
    }
    return null;
  }

  // `powershell -c <payload>` / `pwsh -Command <payload>` - the payload is
  // PowerShell, screened for its own destructive verbs (Remove-Item
  // -Recurse, Format-Volume) as well as the cmd.exe forms it may carry.
  if (head === 'powershell' || head === 'pwsh') {
    const ci = args.findIndex((a) => /^-(c|command|enc|encodedcommand)$/i.test(a));
    if (ci >= 0 && args[ci + 1] !== undefined) {
      return screenPowerShellPayload(args[ci + 1] as string);
    }
    return null;
  }

  if (RECURSIVE_DELETE_HEADS.has(head) && args.some((a) => isFlag(a, '/s'))) {
    return `${head} /s (recursive delete on Windows)`;
  }
  if (ALWAYS_BLOCK_HEADS.has(head)) {
    return head === 'format'
      ? 'format (format filesystem)'
      : 'diskpart (partition disks)';
  }
  if (head === 'reg' && args.length > 0 && REG_DELETE.has((args[0] as string).toLowerCase())) {
    return 'reg delete (delete registry key)';
  }
  if (head === 'bcdedit' && args.some((a) => BCDEDIT_DESTRUCTIVE.has(a.toLowerCase()))) {
    return 'bcdedit (rewrite boot configuration)';
  }
  if (head === 'cipher' && args.some((a) => /^\/w(?::.*)?$/i.test(a))) {
    return 'cipher /w (wipe free space)';
  }
  if (
    head === 'vssadmin' &&
    args.some((a) => a.toLowerCase() === 'delete') &&
    args.some((a) => a.toLowerCase() === 'shadows')
  ) {
    return 'vssadmin delete shadows (delete volume shadow copies)';
  }
  return null;
}

/**
 * Screen a command line for native Windows destructive forms. Returns a
 * reason string, or null when no Windows-native destructive form is found.
 * Pure and platform-independent: it models cmd.exe grammar, not the host.
 */
export function screenWindowsCommand(command: string): string | null {
  for (const segment of splitCmdSegments(command)) {
    const hit = screenCmdSegment(tokenizeCmd(segment));
    if (hit) return hit;
  }
  return null;
}
