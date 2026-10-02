/**
 * Releasing the parent's hold on an abandoned child's stdio.
 *
 * THE DEFECT THIS EXISTS FOR. When we spawn with piped stdio, the pipes are
 * libuv handles owned by US. A descendant of the child that inherits them and
 * outlives it — `notify.sh &`, a started dev server, a language server's helper
 * — keeps the WRITE end open, so our READ end stays open too. Two consequences,
 * and they are separate:
 *
 *   1. `'close'` never fires, because `'close'` is the promise that every
 *      inherited pipe has shut. Anything awaiting it waits forever.
 *   2. The live handles keep OUR event loop alive. Even after we have settled
 *      and finished all our work, `main` falls off the end and the process
 *      does not exit.
 *
 * (1) is fixed by settling on `'exit'` — the child's own lifecycle, which
 * nothing else controls. (2) is what this module fixes: the settle does not
 * release the handles, so the CLI completes its work and then hangs at exit.
 * Measured before this existed: a hook leaving a 3s survivor settled at 206ms
 * and the PROCESS exited at 3,159ms; with a long-lived survivor it never
 * exited at all.
 *
 * ⭐ WHY `unref` AND NOT `destroy`, decided by measurement and not by taste.
 * `destroy()` closes our read end immediately, so a descendant still writing to
 * it takes SIGPIPE and dies. `unref()` cannot signal anything: it only tells
 * libuv this handle must not, by itself, keep the loop alive. Measured with the
 * session still running 3s past the hook's return, a background child that
 * keeps writing SURVIVES under `unref` and is KILLED under `destroy`. Hooks
 * fire mid-session in the TUI, not only at exit, so that difference is real
 * behaviour and not a corner case.
 *
 * ⭐ WHY NOT "kill the descendants harder" — the axis that looks obvious and is
 * wrong. It is too WIDE: a hook that deliberately backgrounds a process is a
 * supported shape, and killing it removes a capability. It is also too NARROW:
 * a descendant that leaves the process group (`setsid`, a double fork) is
 * unreachable by ANY group kill — measured still running at 12s on the timeout
 * path, where the group kill is exactly the mechanism that was supposed to have
 * covered it. Too wide and too narrow at once is the signature of the wrong
 * axis. Releasing our own handle is neither: it kills nothing and it works
 * regardless of what session the descendant escaped to.
 *
 * WHAT IT DOES NOT DO, stated rather than discovered later: a descendant that
 * keeps WRITING to the inherited pipe still dies when the CLI finally exits,
 * because the read end closes with the process. That is inherent — the only way
 * to keep it alive is to not exit, which is the defect. Its output was already
 * being discarded (we settled long before), and the alternative it replaces is
 * an unbounded hang. A daemon that redirects its own stdio, which is the
 * documented and ordinary idiom, is unaffected in every case.
 *
 * CALL IT AT THE MOMENT THE PARENT STOPS CARING — after settling, after
 * teardown — never before, or output still being captured stops holding the
 * loop while it is genuinely still wanted.
 */
import type { ChildProcess } from 'node:child_process';

/**
 * Grace period after a child process exits for its stdio pipes to drain before
 * we settle regardless.
 *
 * `'close'` fires only once EVERY inherited pipe is shut, which is a promise
 * that something else must keep. A child that daemonizes (`setsid …`, a started
 * dev server) leaves the process group, survives the group kill, and holds the
 * inherited stdout/stderr open — measured: `'close'` then never fires at all.
 * Settling on `'exit'` after this drain means the wait can never outlive the
 * child, whatever it leaves behind. The drain costs nothing in the normal case:
 * `'close'` arrives first and settles with the complete output, verified at
 * 1KB, 100KB, 1MB and 8MB of burst-then-exit output.
 *
 * ⭐ ONE definition, deliberately. Both awaiters of a spawned child — the hook
 * runner and the agent's shell executor — key on this same window; two copies
 * of a timing constant that must agree is how the halves of a control drift
 * apart.
 */
export const STDIO_DRAIN_MS = 200;

/**
 * Stop this child's stdio handles from keeping our event loop alive.
 *
 * Never throws, never signals the child, never closes anything: a child that is
 * still writing keeps writing, and anything still readable stays readable for
 * as long as the process lives for some other reason. Safe to call more than
 * once and safe on a child whose streams were never piped.
 */
export function releaseChildStdio(child: ChildProcess): void {
  unrefHandle(child.stdout);
  unrefHandle(child.stderr);
  unrefHandle(child.stdin);
}

/**
 * `unref` the stream if it has one.
 *
 * The child's stdio is typed `Readable`/`Writable`, which declare no `unref` —
 * but a PIPED stdio stream is a `net.Socket` at runtime, and that is the case
 * that holds the loop. Streams from `'ignore'`/`'inherit'` stdio are null and
 * hold nothing, and a stream double in a test may be neither. So the capability
 * is checked rather than asserted: nothing here should throw on a shape that
 * cannot hold the process open in the first place.
 */
function unrefHandle(stream: unknown): void {
  const s = stream as { unref?: () => unknown } | null | undefined;
  if (s && typeof s.unref === 'function') s.unref();
}
