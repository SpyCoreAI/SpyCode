/**
 * The TUI's keybinding contract - the SINGLE source of truth.
 *
 * Hard rule #1: one key, one meaning. Every binding below names the context
 * it lives in (`when`); the suite pins that no two bindings share the same
 * key in the same context, so a new binding can never silently shadow one.
 * `/help` and the Ctrl+P palette render FROM this table, so the documented
 * keys and the implemented keys cannot drift apart.
 */
export type KeyContext =
  | 'composer'
  | 'running'
  | 'approval'
  | 'palette'
  | 'confirm'
  | 'always';

export interface KeyBinding {
  /** Normalized key id, e.g. 'enter', 'ctrl+c', 'escape', 'a'. */
  id: string;
  /** Display label, e.g. 'Ctrl+C'. */
  label: string;
  /** Plain-words description. No jargon. */
  action: string;
  when: KeyContext;
}

export const KEYBINDINGS: readonly KeyBinding[] = [
  // ── composer (idle) ──
  { id: 'enter', label: 'Enter', action: 'send', when: 'composer' },
  { id: 'ctrl+j', label: 'Ctrl+J', action: 'newline', when: 'composer' },
  { id: 'tab', label: 'Tab', action: 'accept suggestion', when: 'composer' },
  { id: 'up', label: '↑/↓', action: 'history at edges, move line otherwise', when: 'composer' },
  { id: 'ctrl+p', label: 'Ctrl+P', action: 'command palette', when: 'composer' },
  { id: 'ctrl+g', label: 'Ctrl+G', action: 'edit in $EDITOR', when: 'composer' },
  { id: 'ctrl+o', label: 'Ctrl+O', action: 'expand elided output', when: 'composer' },
  { id: 'ctrl+y', label: 'Ctrl+Y', action: 'copy last reply', when: 'composer' },
  { id: 'escape', label: 'Esc', action: 'stash draft', when: 'composer' },
  // ── running ──
  { id: 'escape', label: 'Esc', action: 'interrupt run', when: 'running' },
  { id: 'ctrl+c', label: 'Ctrl+C', action: 'abort run', when: 'running' },
  // ── approval ──
  { id: 'a', label: 'a', action: 'accept once', when: 'approval' },
  { id: 'A', label: 'A', action: 'accept all this run', when: 'approval' },
  { id: 'r', label: 'r', action: 'reject', when: 'approval' },
  { id: 'e', label: 'e', action: 'expand arguments', when: 'approval' },
  { id: 'escape', label: 'Esc', action: 'reject', when: 'approval' },
  { id: 'ctrl+c', label: 'Ctrl+C', action: 'reject + abort run', when: 'approval' },
  // ── palette ──
  { id: 'up', label: '↑/↓', action: 'move', when: 'palette' },
  { id: 'enter', label: 'Enter', action: 'run', when: 'palette' },
  { id: 'escape', label: 'Esc', action: 'close', when: 'palette' },
  // ── confirm dialogs (/undo, resume drift) ──
  { id: 'y', label: 'y', action: 'confirm', when: 'confirm' },
  { id: 'n', label: 'n', action: 'cancel', when: 'confirm' },
  { id: 'escape', label: 'Esc', action: 'cancel', when: 'confirm' },
  // ── always ──
  { id: 'ctrl+c', label: 'Ctrl+C', action: 'double-press to quit', when: 'always' },
  { id: 'ctrl+b', label: 'Ctrl+B', action: 'toggle sidebar', when: 'always' },
  // ── composer: transcript search owns the keyboard while open ──
  { id: 'ctrl+f', label: 'Ctrl+F', action: 'transcript search', when: 'composer' },
];

/**
 * Display label for a (context, action) pair in a bindings table, e.g.
 * 'Ctrl+P'. Falls back to the `always` context (global keys). Returns
 * null when the action is unbound - callers must handle null and never
 * render a hardcoded label, or hints drift from the resolved table.
 */
export function labelForAction(
  bindings: readonly KeyBinding[],
  context: KeyContext,
  action: string,
): string | null {
  const direct = bindings.find((b) => b.when === context && b.action === action);
  if (direct) return direct.label;
  const global = bindings.find((b) => b.when === 'always' && b.action === action);
  return global ? global.label : null;
}

/**
 * Resolve a keypress to an approval decision. Pure - the TUI's useInput
 * delegates here so the approval key map is pinned by tests, not by the UI.
 * Esc is reject (default-deny); anything unlisted is null (ignored).
 * Session scope only: a/A/r/Esc (the permanent-allow `w` key was removed -
 * see the proposal; the one-shot `spycore agent` keeps its own `w` flow).
 */
export type ApprovalKeyAction = 'accept' | 'accept_all' | 'reject';

export function approvalKeyFor(input: string, escape: boolean): ApprovalKeyAction | null {
  if (escape) return 'reject';
  if (input === 'a') return 'accept';
  if (input === 'A') return 'accept_all';
  if (input === 'r') return 'reject';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// F16: user-customizable keybindings.
//
// The KEYBINDINGS table above is the PINNED contract - the defaults every
// install ships with. Users may rebind keys via the `keybindings` config
// key (`spycore config set keybindings '<json>'` or a hand-edited config
// file); the functions below resolve those overrides onto the contract.
//
// Resolution rules (fail-closed):
//  1. An override names an existing (context, action) pair - it REBINDS that
//     binding's key. It can never invent a new action or rename one, so the
//     contract's action vocabulary stays pinned.
//  2. "One key, one meaning" is re-validated over the RESOLVED table: if any
//     two bindings would share a key in the same context, EVERYTHING is
//     rejected and the caller gets the pristine KEYBINDINGS plus the errors.
//     A broken keymap is never half-applied.
//  3. Ambiguous targets are rejected, not guessed: `approval`/`reject` is
//     bound twice (`r` and `Esc`) - an override for it must disambiguate with
//     `from`.
// ─────────────────────────────────────────────────────────────────────────────

/** All valid key contexts, for validating user-supplied overrides. */
export const KEY_CONTEXTS: readonly KeyContext[] = [
  'composer',
  'running',
  'approval',
  'palette',
  'confirm',
  'always',
];

/**
 * One user-supplied rebinding: in `context`, the binding that performs
 * `action` moves to `key`. `from` disambiguates when several bindings share
 * the same action in one context (e.g. `approval`/`reject` on `r` and `Esc`).
 */
export interface KeybindingOverride {
  context: KeyContext;
  action: string;
  /** User-written key, e.g. 'Ctrl+J', 'ctrl+j', 'Enter'. Normalized on parse. */
  key: string;
  /** Optional: the binding's CURRENT key, to disambiguate shared actions. */
  from?: string | undefined;
}

/** Named base keys accepted in overrides. */
const NAMED_KEYS = new Set([
  'enter',
  'escape',
  'tab',
  'up',
  'down',
  'left',
  'right',
  'space',
  'backspace',
  'delete',
  'home',
  'end',
  'pageup',
  'pagedown',
  'insert',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
]);

const MODIFIERS = new Set(['ctrl', 'alt', 'meta', 'shift']);

/**
 * The exact image of keyIdForInkEvent: the only key ids the TUI can ever
 * observe. Binding a rebind TARGET to anything outside this set (single
 * letters like 'x', space, f1-f12, alt/shift combos) makes the action
 * unreachable while /help advertises it - the dispatchability gate checks
 * the ACTION, this checks the KEY.
 */
const PRODUCIBLE_KEY_IDS: ReadonlySet<string> = new Set([
  'enter', 'escape', 'tab', 'up', 'down', 'left', 'right',
  'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'insert',
  ...(['ctrl', 'meta'] as const).flatMap((mod) =>
    'abcdefghijklmnopqrstuvwxyz0123456789'.split('').map((ch) => `${mod}+${ch}`),
  ),
]);

/**
 * Normalize a user-written key to the contract's id form (`ctrl+j`).
 * Accepts `Ctrl+J`, `CTRL-J`, `ctrl + j`. Throws on anything that is not a
 * valid key: empty input, unknown modifiers, unknown base keys, or a
 * repeated modifier. `-` is a separator exactly like `+` (so the literal
 * minus key cannot be bound - documented, not a bug). The table's ids are
 * already normalized, so overrides and defaults compare on equal terms.
 */
export function normalizeKeyId(raw: string): string {
  const parts = raw
    .split(/[+\-]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`invalid key: ${JSON.stringify(raw)} (empty)`);
  const base = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const seen = new Set<string>();
  for (const m of mods) {
    if (!MODIFIERS.has(m)) {
      throw new Error(`invalid key: ${JSON.stringify(raw)} (unknown modifier ${JSON.stringify(m)})`);
    }
    if (seen.has(m)) {
      throw new Error(`invalid key: ${JSON.stringify(raw)} (repeated modifier ${JSON.stringify(m)})`);
    }
    seen.add(m);
  }
  const isSingle = /^[a-z0-9]$/.test(base);
  if (!isSingle && !NAMED_KEYS.has(base)) {
    throw new Error(`invalid key: ${JSON.stringify(raw)} (unknown key ${JSON.stringify(base)})`);
  }
  const ordered = [...seen].sort();
  return ordered.length > 0 ? `${ordered.join('+')}+${base}` : base;
}

/** Display label for a normalized key id: `ctrl+j` -> `Ctrl+J`, `escape` -> `Esc`. */
export function displayLabelForKeyId(id: string): string {
  const pretty: Record<string, string> = {
    enter: 'Enter',
    escape: 'Esc',
    tab: 'Tab',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Del',
  };
  return id
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'alt') return 'Alt';
      if (p === 'meta') return 'Meta';
      if (p === 'shift') return 'Shift';
      if (/^f\d+$/.test(p)) return p.toUpperCase();
      if (p.length === 1) return p.toUpperCase();
      return pretty[p] ?? p;
    })
    .join('+');
}

/** Validate one raw override object. Returns the normalized override or an error. */
export function parseKeybindingOverride(
  raw: unknown,
  index: number,
): { override: KeybindingOverride } | { error: string } {
  const where = `keybindings[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${where}: must be an object {context, action, key}` };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.context !== 'string' || !(KEY_CONTEXTS as readonly string[]).includes(o.context)) {
    return {
      error: `${where}: unknown context ${JSON.stringify(o.context)} (want one of: ${KEY_CONTEXTS.join(', ')})`,
    };
  }
  if (typeof o.action !== 'string' || o.action.length === 0) {
    return { error: `${where}: action must be a non-empty string` };
  }
  if (typeof o.key !== 'string' || o.key.length === 0) {
    return { error: `${where}: key must be a non-empty string` };
  }
  let from: string | undefined;
  if (o.from !== undefined) {
    if (typeof o.from !== 'string' || o.from.length === 0) {
      return { error: `${where}: from must be a non-empty string when present` };
    }
    try {
      from = normalizeKeyId(o.from);
    } catch (err) {
      return { error: `${where}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  let key: string;
  try {
    key = normalizeKeyId(o.key);
  } catch (err) {
    return { error: `${where}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The terminal can never produce this key id, so the action would become
  // unreachable while /help advertises it. Fail closed with a clear error
  // instead of silently breaking the action.
  if (!PRODUCIBLE_KEY_IDS.has(key)) {
    return {
      error: `${where}: key ${JSON.stringify(key)} can never be produced by the terminal ` +
        `(not a bindable key) - binding ${JSON.stringify(o.action)} to it would make the action unreachable`,
    };
  }
  return {
    override: {
      context: o.context as KeyContext,
      action: o.action,
      key,
      ...(from !== undefined ? { from } : {}),
    },
  };
}

export interface ResolvedKeybindings {
  /**
   * The effective table. On ANY validation failure this is the pristine
   * KEYBINDINGS - fail-closed, never a half-rebound table.
   */
  bindings: readonly KeyBinding[];
  /** Empty when resolution succeeded. */
  errors: string[];
}

/**
 * Resolve user overrides onto the pinned contract. Pure and unit-testable:
 * pass the raw `keybindings` config value (or undefined for defaults).
 *
 * Validation order: shape -> target lookup (unknown action, ambiguous
 * action) -> apply -> the "one key, one meaning" invariant over the whole
 * resolved table. The first failure aborts with defaults + all errors
 * collected so far.
 */
export function resolveKeybindings(overrides: unknown): ResolvedKeybindings {
  if (overrides === undefined || overrides === null) {
    return { bindings: KEYBINDINGS, errors: [] };
  }
  if (!Array.isArray(overrides)) {
    return { bindings: KEYBINDINGS, errors: ['keybindings: must be an array of overrides'] };
  }
  const errors: string[] = [];
  const parsed: KeybindingOverride[] = [];
  overrides.forEach((raw, i) => {
    const r = parseKeybindingOverride(raw, i);
    if ('error' in r) errors.push(r.error);
    else parsed.push(r.override);
  });
  if (errors.length > 0) return { bindings: KEYBINDINGS, errors };

  const resolved: KeyBinding[] = KEYBINDINGS.map((b) => ({ ...b }));
  // Dispatchability gate (M1): only actions the TUI actually dispatches
  // through the table can be rebound. Others fall through to hardcoded
  // handlers that implement default keys, so accepting a rebind would
  // silently do nothing while /help advertises it.
  const WIRED_ACTIONS: ReadonlySet<string> = new Set([
    'toggle sidebar',      // always
    'command palette',     // composer
    'edit in $EDITOR',     // composer
    'expand elided output', // composer
    'copy last reply',      // composer
  ]);
  // Keys with hardcoded behavior that the contract table does not list, so
  // the conflict checker below cannot see them. A rebind landing here
  // would hijack hardcoded handling (history navigation, cursor movement,
  // delete, filter editing) while /help shows the rebound action.
  const HARDCODED_RESERVED: Readonly<Record<KeyContext, ReadonlySet<string>>> = {
    composer: new Set(['down', 'left', 'right', 'backspace', 'delete']),
    running: new Set(),
    approval: new Set(),
    palette: new Set(['down', 'backspace', 'delete']),
    confirm: new Set(),
    always: new Set(),
  };
  const alwaysKeys = new Set(
    KEYBINDINGS.filter((b) => b.when === 'always').map((b) => b.id),
  );
  // Keys that overrides moved into the `always` context. actionForKey
  // checks the direct context FIRST and only then the `always` fallback,
  // so an always-rebind landing on a key another context binds directly
  // would be silently dead there. Tracked to check in the final pass.
  const movedAlwaysKeys = new Set<string>();
  for (const o of parsed) {
    const candidates = resolved.filter((b) => b.when === o.context && b.action === o.action);
    if (candidates.length === 0) {
      errors.push(
        `keybindings: unknown action ${JSON.stringify(o.action)} in context ${JSON.stringify(o.context)} ` +
          `(overrides can only rebind actions from the pinned contract)`,
      );
      continue;
    }
    if (!WIRED_ACTIONS.has(o.action)) {
      errors.push(
        `keybindings: action ${JSON.stringify(o.action)} cannot be rebound ` +
          `(only ${[...WIRED_ACTIONS].join(', ')} are table-dispatched; ` +
          `other keys are pinned to their defaults)`,
      );
      continue;
    }
    // Bidirectional invariant: always-keys are globally reserved.
    if (o.context !== 'always' && alwaysKeys.has(o.key)) {
      errors.push(
        `keybindings: ${JSON.stringify(o.key)} is reserved by the "always" context - ` +
          `cannot bind ${JSON.stringify(o.action)} to it in ${JSON.stringify(o.context)}`,
      );
      continue;
    }
    // Hardcoded-reserved keys cannot be rebind targets in contexts where
    // they have hardcoded behavior (see HARDCODED_RESERVED). The conflict
    // checker only sees the contract table, so without this the override
    // would silently hijack e.g. history navigation.
    if (HARDCODED_RESERVED[o.context].has(o.key)) {
      errors.push(
        `keybindings: ${JSON.stringify(o.key)} is reserved for hardcoded ${o.context} behavior ` +
          `(history navigation / cursor movement / editing) - cannot rebind ${JSON.stringify(o.action)} onto it`,
      );
      continue;
    }
    let target: KeyBinding | undefined;
    if (o.from !== undefined) {
      target = candidates.find((b) => b.id === o.from);
      if (!target) {
        errors.push(
          `keybindings: no ${JSON.stringify(o.action)} binding on ${JSON.stringify(o.from)} ` +
            `in context ${JSON.stringify(o.context)}`,
        );
        continue;
      }
    } else if (candidates.length > 1) {
      errors.push(
        `keybindings: action ${JSON.stringify(o.action)} in context ${JSON.stringify(o.context)} ` +
          `is bound ${candidates.length} times (${candidates.map((b) => b.id).join(', ')}) - ` +
          `add "from" to disambiguate`,
      );
      continue;
    } else {
      target = candidates[0]!;
    }
    target.id = o.key;
    target.label = displayLabelForKeyId(o.key);
    if (o.context === 'always') movedAlwaysKeys.add(o.key);
  }
  if (errors.length > 0) return { bindings: KEYBINDINGS, errors };

  // The invariant, re-checked over the RESOLVED table: one key, one meaning
  // per context. (Cross-context sharing is legal - Esc means different
  // things in composer vs approval by design.)
  const seen = new Map<string, string>();
  for (const b of resolved) {
    const k = `${b.when}\u0000${b.id}`;
    const prev = seen.get(k);
    if (prev !== undefined) {
      errors.push(
        `keybindings: conflict - ${JSON.stringify(b.id)} in context ${JSON.stringify(b.when)} ` +
          `would trigger both ${JSON.stringify(prev)} and ${JSON.stringify(b.action)}`,
      );
    } else {
      seen.set(k, b.action);
    }
  }
  if (errors.length > 0) return { bindings: KEYBINDINGS, errors };

  // Bidirectional invariant: `always`-context keys are globally reserved
  // against USER OVERRIDES. A user override that puts an `always` key
  // (e.g. Ctrl+C) into another context would be silently stolen by the
  // global-first handler, so we reject the whole table instead of
  // half-applying it. (The pinned contract itself intentionally reuses
  // Ctrl+C across contexts with documented priority - that is not a
  // violation, only new override-introduced conflicts are.)
  //
  // `always`-context REBINDS must land on keys no other context binds
  // directly: actionForKey tries the direct context first, so an
  // always-rebind onto e.g. escape would be dead everywhere without this
  // check. (The pinned contract's own Ctrl+C cross-context reuse is
  // grandfathered - only override-moved keys count here.)
  for (const kid of movedAlwaysKeys) {
    const blockers = resolved.filter((b) => b.when !== 'always' && b.id === kid);
    if (blockers.length > 0) {
      errors.push(
        `keybindings: ${JSON.stringify(kid)} in the "always" context is shadowed by ` +
          blockers.map((b) => `${JSON.stringify(b.action)} (${b.when})`).join(', ') +
          ` - pick a key no other context binds`,
      );
    }
  }

  if (errors.length > 0) return { bindings: KEYBINDINGS, errors };
  return { bindings: resolved, errors: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// M1: TUI integration helpers.
//
// The KEYBINDINGS table + resolveKeybindings() above define the contract.
// The functions below wire it into the live TUI: converting Ink key events
// to normalized ids, and looking up actions in the resolved table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal Ink key shape (from `useInput((input, key) => ...)`).
 * Declared structurally so this stays testable without importing Ink.
 */
export interface InkKeyEvent {
  ctrl: boolean;
  meta: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  insert?: boolean;
}

/**
 * Convert an Ink key event to a normalized key id (`ctrl+c`, `enter`, ...).
 * Returns null for plain text input (no special key) - the caller treats
 * that as typing, not a binding.
 *
 * Priority mirrors Ink's own parsing: named keys first, then ctrl/meta
 * combos, then shift-modified letters, then single characters.
 */
export function keyIdForInkEvent(input: string, key: InkKeyEvent): string | null {
  if (key.return) return 'enter';
  if (key.escape) return 'escape';
  if (key.tab) return 'tab';
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.backspace) return 'backspace';
  if (key.delete) return 'delete';
  if (key.home) return 'home';
  if (key.end) return 'end';
  if (key.pageUp) return 'pageup';
  if (key.pageDown) return 'pagedown';
  if (key.insert) return 'insert';
  // Ctrl/Meta combos: input is the base character.
  if ((key.ctrl || key.meta) && input.length === 1) {
    const mod = key.ctrl ? 'ctrl' : 'meta';
    const base = input.toLowerCase();
    if (/^[a-z0-9]$/.test(base)) return `${mod}+${base}`;
    return null;
  }
  // Shift+letter without ctrl/meta is just an uppercase letter - typing.
  // Shift+special (e.g. shift+tab) has no contract entry; treat as unbound.
  return null;
}

/**
 * Look up the action for a normalized key id in a specific context.
 * Falls back to the `always` context (global keys like Ctrl+C).
 * Returns null when the key is unbound in both.
 */
export function actionForKey(
  bindings: readonly KeyBinding[],
  context: KeyContext,
  keyId: string,
): string | null {
  const direct = bindings.find((b) => b.when === context && b.id === keyId);
  if (direct) return direct.action;
  const global = bindings.find((b) => b.when === 'always' && b.id === keyId);
  return global ? global.action : null;
}

