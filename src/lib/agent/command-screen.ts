/**
 * The run_command screener: `matchesCatastrophic` and the tables it reads.
 * tools.ts re-exports every name exported here, so its public surface is
 * unchanged.
 *
 * M-8 - this was one 2199-line file. It is now four focused modules plus this
 * barrel, split along the natural seams:
 *   command-screen/constants.ts  the tables the screen reads (shells, device
 *                                sets, path segments, write verbs, interpreters)
 *   command-screen/device.ts     device / sensitive-path targeting
 *                                (`isRawDevice`, `dangerousTarget`, …)
 *   command-screen/shell-args.ts shell-text handling (`splitArgs`, brace and
 *                                continuation analysis, fallback tokenization)
 *   command-screen/engine.ts     the screen pipeline itself (`screenShell`,
 *                                `screenCommands`, `screenArgv`, payload
 *                                extraction)
 * The engine is mutually recursive (`screenArgv` re-enters `screenShell` for
 * nested payloads), so it stays one module; the other three are acyclic
 * leaves. No runtime import cycles: the N35 pin in
 * tests/tools-split-pins.test.ts still holds.
 *
 * The NUL byte lives in `device.ts` now (the separator of the per-call dedup
 * key in `dangerousTarget`). Search tools that skip binary files skip that
 * file too; use `grep -a` or AST tooling.
 */
import { screenShell } from './command-screen/engine.js';

/**
 * A SMALL safety net (NOT a sandbox): hard-block obviously catastrophic
 * commands BEFORE the approval prompt, so even --yes cannot run them. The real
 * protections are the cwd, the approval prompt, and the timeout; OS-level
 * sandboxing is a later phase. Returns a reason string, or null when allowed.
 *
 * F-2c-4b - THE INSTRUMENT, NOT THE PATTERN. This used to be regexes over
 * RAW shell text. Measured at `a391ee88`, that axis failed in BOTH directions
 * at once: 42 of 59 catastrophic forms were ALLOWED (`rm -rf />/dev/null`,
 * `r\m -rf /`, `rm -r"f" /`, `dd of=/dev/loop0`) while 7 of 34 benign ones were
 * BLOCKED (`echo "rm -rf /" >> notes.md`). Simultaneously too narrow and too
 * wide IS the definition of the wrong axis, and it is not fixable by tuning:
 * widening the target terminator was measured to close 11 evasions while
 * ADDING 2 over-blocks and flipping two of `agent-command.test.ts`'s own
 * assertions red.
 *
 * So the screen now reads WORDS, via `parseShell`, and asks the question that
 * actually matters - "which word is the command, and what are its operands?"
 * There is exactly ONE instrument: the old regex screen is gone rather than
 * left standing beside this, because two mechanisms guarding one property are
 * a bypass surface by construction (F-2c-1's own best result).
 *
 * Still deliberately not exhaustive: encoded payloads (`base64 | sh`), `$IFS`
 * splicing and eval chains remain out of scope, and the approval prompt remains
 * the primary control.
 */
export function matchesCatastrophic(command: string): string | null {
  return screenShell(command, 0);
}

// The one expansion model lives in shell-parse.ts; re-exported here so the
// screen's consumers keep a single import (unchanged from the single-file era).
export { stripExpansions } from './shell-parse.js';
// H-15: invisible-unicode detection (homoglyph defense) - a flag for the
// approval prompt, not a hard block.
export {
  findInvisibleUnicode,
  invisibleUnicodeNotice,
  type InvisibleHit,
} from './command-screen/invisible.js';

export {
  MAX_SCREEN_DEPTH,
  SHELLS,
  COMMAND_CARRIERS,
  SAFE_DEVICES,
  SAFE_DEVICE_ROLES,
  SYSTEM_TREE_SEGMENTS,
  DATA_CONTAINER_SEGMENTS,
  INSTALL_CONTAINER_SEGMENTS,
  DEVICE_WRITE_VERBS,
  INTERPRETERS,
  INTERPRETER_CODE_FLAGS,
} from './command-screen/constants.js';
