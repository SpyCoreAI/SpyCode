import { createInterface, type Interface } from 'node:readline';
import { sanitizeForDisplay } from './sanitize-display.js';

/**
 * Stdin/stdout prompt helpers. Built on Node's readline so we don't drag
 * in inquirer (~80KB minified) for what is essentially three small utilities.
 *
 * Three flavours:
 *   - readSingleLineInput    — one line, returns once Enter is pressed
 *   - readMultilineInput     — many lines, returns on empty-line + Enter or EOF
 *   - readStdinPipe          — read everything from a piped stdin, no prompt
 *
 * SIGINT (Ctrl+C) closes the readline interface and rejects the promise so
 * commands can `try/catch` and exit cleanly with the conventional 130 code.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THE PROMPT BOUNDARY. Every prompt STRING rendered by this module crosses
 * the display sanitizer first.
 *
 * SECURITY.md §2 names this exact threat — *"restyled or overwritten approval
 * prompts"* — and calls the approval gate the primary control. A prompt is the
 * one surface where a forged line does not merely mislead, it harvests a "y".
 * Two of the nine holes F-2c-9 closed were approval prompts reached from here.
 *
 * ⭐ WHY HERE AS WELL AS AT THE CALL SITE. F-2c-9 closed those nine at the
 * COMPOSITION boundary (`display\`…\``) and gated them on the property (P1).
 * That is a real control, but it is ONE layer, and its blind spot is proven
 * real rather than argued: a value reaching a prompt through a helper the
 * census cannot classify is invisible to it (plant B5). This layer does not
 * know or care where the string came from, which is exactly the point.
 *
 * ⭐ ITS COST WAS MEASURED, AND IT IS PAID. All 21 prompt sites in the package
 * were counted at current state; exactly ONE composes CLI-authored styling —
 * `skills/create.ts:221`, whose three `chalk.bold` markers now render FLAT.
 * The text is byte-identical (`[a] accept  [r] reject  [e] edit feedback ›`);
 * only the bold attribute is gone. That cost is accepted deliberately —
 * defence in depth on a value an attacker controls is worth three bold markers
 * in one flow — and B17 pins the population so it cannot spread past what was
 * measured.
 *
 * ⭐ WHAT IS NOT TOUCHED: THE ANSWER. `readSingleLineInput` returns the user's
 * own keystrokes verbatim and `readStdinPipe` carries no prompt at all. The
 * user's own words are never scrubbed — pin 0b.
 */

export interface PromptError extends Error {
  readonly cancelled: true;
}

function makeCancelledError(): PromptError {
  const e = new Error('cancelled') as PromptError & { cancelled: true };
  Object.defineProperty(e, 'cancelled', { value: true, enumerable: true });
  return e;
}

export function isPromptCancelled(err: unknown): err is PromptError {
  return Boolean(
    err && typeof err === 'object' && (err as { cancelled?: unknown }).cancelled === true,
  );
}

/** Read a single line. The prompt is written to stderr so stdout stays clean. */
export async function readSingleLineInput(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl: Interface = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stdin.isTTY === true,
      historySize: 100,
    });
    let answered = false;

    const onSigint = () => {
      if (answered) return;
      rl.close();
      reject(makeCancelledError());
    };
    rl.on('SIGINT', onSigint);

    // THE BOUNDARY. readline writes this string to the interface's `output`
    // (process.stderr) verbatim — this is the last point we control.
    rl.question(sanitizeForDisplay(prompt), (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Read a multi-line message. The user sees the `prompt` once, then types
 * across N lines. We finish on EITHER:
 *   - an empty line followed by Enter (matches the Unix-y "blank line ends
 *     paragraph" intuition)
 *   - EOF (Ctrl+D on Unix, Ctrl+Z + Enter on Windows)
 * Returns the joined input WITHOUT the trailing blank line.
 */
export async function readMultilineInput(opts?: {
  prompt?: string;
  allowEmpty?: boolean;
}): Promise<string> {
  const prompt = opts?.prompt ?? '> ';
  const allowEmpty = opts?.allowEmpty ?? false;

  return new Promise((resolve, reject) => {
    const rl: Interface = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stdin.isTTY === true,
      historySize: 100,
    });
    const lines: string[] = [];
    let lastWasEmpty = false;

    const finish = () => {
      rl.close();
      const text = lines.join('\n').replace(/\n+$/, '');
      if (!allowEmpty && text.length === 0) {
        reject(makeCancelledError());
        return;
      }
      resolve(text);
    };

    rl.on('line', (line) => {
      if (line === '' && lastWasEmpty) {
        // Two empty lines in a row = "send" — drop the most recent and finish.
        if (lines.length > 0) lines.pop();
        finish();
        return;
      }
      if (line === '' && lines.length > 0) {
        lastWasEmpty = true;
        finish();
        return;
      }
      if (line === '') {
        lastWasEmpty = true;
        return;
      }
      lastWasEmpty = false;
      lines.push(line);
    });

    rl.on('close', () => {
      // EOF / Ctrl+D path — if we already resolved/rejected via the "line"
      // handler above, this is a no-op because resolve/reject are settled.
      const text = lines.join('\n').replace(/\n+$/, '');
      if (!allowEmpty && text.length === 0) {
        reject(makeCancelledError());
        return;
      }
      resolve(text);
    });

    rl.on('SIGINT', () => {
      rl.close();
      reject(makeCancelledError());
    });

    // THE BOUNDARY — the same one as readSingleLineInput, on the other flavour.
    process.stderr.write(sanitizeForDisplay(prompt));
  });
}

/**
 * Slurp stdin until EOF. Useful for `echo "..." | spycore chat --stdin`
 * pipelines. Does NOT emit a prompt; if stdin is a TTY (no pipe) we
 * resolve immediately with empty string so callers can detect missing input.
 */
export async function readStdinPipe(): Promise<string> {
  if (process.stdin.isTTY === true) return '';
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', reject);
  });
}
