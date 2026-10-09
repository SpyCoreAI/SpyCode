import ora, { type Options as OraOptions, type Ora } from 'ora';
import { sanitizeForDisplay } from './sanitize-display.js';

/**
 * THE SPINNER BOUNDARY - the one place a spinner's text can be set.
 *
 * WHY A SINK-SIDE BOUNDARY HERE AND NOT ONLY AT THE CALL SITES.
 * F-2c-9 closed the wire→sink class at its COMPOSITION boundary (`display\`…\``)
 * and gated it on the property (P1). That is a real control, but it is ONE
 * layer: a value reaching a spinner by a route the census does not classify -
 * an unknown wrapper call, a wire origin outside the seed list - is invisible
 * to it, and that false negative is proven real (plant B5). This boundary is
 * the second layer. It does not know or care where the text came from.
 *
 * ITS COST WAS MEASURED BEFORE IT WAS TAKEN, NOT ASSUMED. Every text-bearing
 * spinner site in the package was counted at current state: **16 of 37 spinner
 * sites carry text, and ZERO of them carry CLI-authored styling.** So unlike
 * the prompt boundary (which flattens exactly one styled prompt), this one
 * costs nothing at all today - and `spinnerTextSitesCarryNoStyling` in
 * display-sink-reach.test.ts pins that, so the cost cannot start being paid
 * silently when someone adds a chalked spinner label.
 *
 * WHAT IS DELIBERATELY *NOT* SANITIZED: THE STREAM.
 * A spinner's own control bytes - cursor hide/show, line rewrite, the frame
 * glyphs - are authored by `ora` and written straight to the raw
 * `process.stderr`/`process.stdout` handed in here. Routing that stream through
 * anything that scrubs escapes would not harden the CLI, it would break
 * progress rendering outright. T2 pins the stream's IDENTITY by execution for
 * exactly this reason. The untrusted part of a spinner is its TEXT, so that is
 * the only thing this touches.
 *
 * ONE MECHANISM, NOT TWO. Everything below calls `sanitizeForDisplay` - the
 * single sanitizer in `sanitize-display.ts`. This is a wrapper in the same
 * sense `display\`…\`` is; pin 0c still asserts there is only one.
 *
 * AND IT CANNOT BE HALF-APPLIED. A `Proxy` covers every text-bearing member
 * of `Ora`, including the four this package does not use yet (`warn`, `info`,
 * `stopAndPersist`, `prefixText`). A hand-written `sanitizeForDisplay(...)` at
 * each of today's 16 sites would leave the 17th, added later, uncovered - which
 * is precisely how nine holes shipped in 0.6.0.
 */

/** `Ora` members whose first argument is rendered text. */
const TEXT_METHODS: ReadonlySet<string> = new Set(['start', 'succeed', 'fail', 'warn', 'info']);
/** `Ora` string properties that are rendered. `color`/`indent` are not text. */
const TEXT_PROPS: ReadonlySet<string> = new Set(['text', 'prefixText', 'suffixText']);

/** Sanitize a value only when it is a string; ora accepts generators too. */
function cleanValue(value: unknown): unknown {
  return typeof value === 'string' ? sanitizeForDisplay(value) : value;
}

/** `stopAndPersist({ text, prefixText, suffixText, symbol })` - clean each. */
function cleanPersist(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of ['text', 'prefixText', 'suffixText', 'symbol'])
    if (k in out) out[k] = cleanValue(out[k]);
  return out;
}

/**
 * Wrap a live spinner so every text that reaches it crosses the sanitizer.
 *
 * Methods are invoked with `this` bound to the REAL spinner (never the proxy),
 * so ora's internals are untouched; a method returning `this` is re-wrapped so
 * chaining (`createSpinner(…).start()`) stays inside the boundary rather than
 * handing the caller back a raw, unguarded instance.
 */
function guard(spinner: Ora): Ora {
  const proxy: Ora = new Proxy(spinner, {
    get(target, prop): unknown {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        let call = args;
        if (typeof prop === 'string' && TEXT_METHODS.has(prop))
          call = [cleanValue(args[0]), ...args.slice(1)];
        else if (prop === 'stopAndPersist') call = [cleanPersist(args[0]), ...args.slice(1)];
        const out = fn.apply(target, call);
        return out === target ? proxy : out;
      };
    },
    set(target, prop, value): boolean {
      const next = typeof prop === 'string' && TEXT_PROPS.has(prop) ? cleanValue(value) : value;
      return Reflect.set(target, prop, next, target);
    },
  });
  return proxy;
}

/**
 * Construct a spinner whose text is sanitized at every entry point.
 *
 * `stream` is REQUIRED and passed through untouched - callers keep the exact
 * stream they had (`files`/`image`/`git-workflow` use stderr so progress stays
 * out of pipes; `auth login` keeps stdout, which is what it has always used).
 * Defaulting it here would silently move one command's output to another
 * stream, which is a user-visible change no ruling sanctions.
 */
export function createSpinner(options: OraOptions & { readonly stream: NodeJS.WritableStream }): Ora {
  const opts: Record<string, unknown> = { ...options };
  for (const k of TEXT_PROPS) if (k in opts) opts[k] = cleanValue(opts[k]);
  return guard(ora(opts as OraOptions));
}
