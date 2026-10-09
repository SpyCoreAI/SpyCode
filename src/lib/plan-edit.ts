/**
 * EDITABLE PLAN - PHASE-1 1.11.
 *
 * Render-agnostic core for the plan menu's [e]dit option (the commit-flow
 * philosophy): pure line operations + a session loop driven entirely through
 * a caller-supplied IO, so both interactive hosts (the chat TUI and the
 * agent TUI) share ONE behavior and the operations are unit-testable
 * without a TTY.
 *
 * Shape decisions (investigated first):
 *  - The plan artifact is a FREE-TEXT markdown string (runAgent plan-phase
 *    finalText) - no structured step list exists anywhere, so the surface is
 *    a NUMBERED-LINE replace loop (edit / delete / insert-after by line
 *    number), not a step parser. No semantic "step discovery" happens here.
 *  - The interact primitive is SINGLE-LINE (Enter resolves, Esc cancels),
 *    so every operation takes exactly one one-line answer.
 *  - No $EDITOR: the codebase has zero external-editor precedent, pinned.
 *
 * SECURITY INVARIANT (extends the 1.7 pin): an EDITED plan pre-approves
 * NOTHING. The session only transforms a local string; approval remains a
 * separate explicit menu step, and execution still walks the normal
 * per-action approvals, the 1.10 command rules (catastrophic-first), and
 * hooks. No code path from plan content to approval state exists.
 */
import { sanitizeForDisplay } from './sanitize-display.js';

export interface PlanEditIo {
  /** Show the numbered listing (display-sanitized by this module). */
  present(text: string): void;
  /** One-line operation answer; Esc arrives as 'c' (interact 'choice'). */
  ask(question: string): Promise<string>;
  /** One-line text answer; Esc arrives as '' (interact 'text'). */
  readText(question: string): Promise<string>;
  notify(kind: 'info' | 'success' | 'warning' | 'error', text: string): void;
}

export interface PlanEditResult {
  /** The resulting plan: edited text, or the ORIGINAL when discarded. */
  plan: string;
  /** True only when the session finished with text ≠ the original. */
  edited: boolean;
}

export type PlanEditOp =
  | { op: 'edit'; line: number }
  | { op: 'delete'; line: number }
  | { op: 'insert'; line: number }
  | { op: 'done' }
  | { op: 'discard' }
  | { op: 'invalid'; reason: string };

type LinesResult = { ok: true; lines: string[] } | { ok: false; reason: string };

export function planToLines(plan: string): string[] {
  return plan.split('\n');
}

export function linesToPlan(lines: string[]): string {
  return lines.join('\n');
}

/** True when the plan has no non-whitespace content at all. */
export function isPlanBlank(lines: string[]): boolean {
  return lines.every((l) => l.trim().length === 0);
}

/** The numbered listing shown between operations. Pure - no sanitization. */
export function renderNumberedPlan(lines: string[]): string {
  const width = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(width)}│ ${l}`)
    .join('\n');
}

const OP_PROMPT =
  'edit ops - [e N] edit line · [d N] delete line · [i N] insert after N (0 = top) · Enter = done · [x] discard: ';

/**
 * Parse one operation answer. `lineCount` bounds the line arguments
 * (1..lineCount for edit/delete; 0..lineCount for insert-after).
 */
export function parsePlanEditOp(input: string, lineCount: number): PlanEditOp {
  const answer = input.trim().toLowerCase();
  if (answer === '' || answer === 'done') return { op: 'done' };
  // Esc on the op prompt arrives as 'c' (the interact 'choice' contract) -
  // inside the edit session that means DISCARD, never run-cancel.
  if (answer === 'x' || answer === 'c' || answer === 'q' || answer === 'cancel' || answer === 'discard') {
    return { op: 'discard' };
  }
  const m = /^(e|edit|d|delete|del|i|insert)\s+(\d+)$/.exec(answer);
  if (!m) return { op: 'invalid', reason: `Unrecognized - use e N, d N, i N, Enter (done) or x (discard).` };
  const n = Number(m[2]);
  const op = m[1]![0] as 'e' | 'd' | 'i';
  if (op === 'i') {
    if (n < 0 || n > lineCount) {
      return { op: 'invalid', reason: `Insert position must be 0–${lineCount}.` };
    }
    return { op: 'insert', line: n };
  }
  if (n < 1 || n > lineCount) {
    return { op: 'invalid', reason: `Line must be 1–${lineCount}.` };
  }
  return op === 'e' ? { op: 'edit', line: n } : { op: 'delete', line: n };
}

/** Replace line `line` (1-based). Blank `text` is a caller-side cancel. */
export function applyEditLine(lines: string[], line: number, text: string): LinesResult {
  if (line < 1 || line > lines.length) return { ok: false, reason: `Line must be 1–${lines.length}.` };
  const next = [...lines];
  next[line - 1] = text;
  if (isPlanBlank(next)) {
    return { ok: false, reason: 'That edit would blank the whole plan - use x to discard, or [c]ancel from the menu.' };
  }
  return { ok: true, lines: next };
}

/** Delete line `line` (1-based); refuses to empty the plan. */
export function applyDeleteLine(lines: string[], line: number): LinesResult {
  if (line < 1 || line > lines.length) return { ok: false, reason: `Line must be 1–${lines.length}.` };
  const next = lines.filter((_, i) => i !== line - 1);
  if (next.length === 0 || isPlanBlank(next)) {
    return { ok: false, reason: 'The plan cannot be emptied - use x to discard the edits, or [c]ancel from the menu.' };
  }
  return { ok: true, lines: next };
}

/** Insert `text` AFTER line `line` (0 = at the top). */
export function applyInsertAfter(lines: string[], line: number, text: string): LinesResult {
  if (line < 0 || line > lines.length) return { ok: false, reason: `Insert position must be 0–${lines.length}.` };
  const next = [...lines.slice(0, line), text, ...lines.slice(line)];
  return { ok: true, lines: next };
}

/**
 * The interactive edit session: list → operate → re-list, until Enter
 * (keep the edits) or x/Esc (discard - the ORIGINAL plan is returned
 * unchanged; this is NOT run-cancel). The result is guaranteed non-blank:
 * every operation that would blank the plan is refused with an explanation
 * and the loop continues - never a crash, never a silent approval.
 */
export async function runPlanEditSession(plan: string, io: PlanEditIo): Promise<PlanEditResult> {
  let lines = planToLines(plan);
  io.notify('info', 'Editing the plan - changes apply only after you approve it from the menu.');
  for (;;) {
    io.present(sanitizeForDisplay(renderNumberedPlan(lines)));
    const op = parsePlanEditOp(await io.ask(OP_PROMPT), lines.length);
    if (op.op === 'invalid') {
      io.notify('warning', op.reason);
      continue;
    }
    if (op.op === 'discard') {
      io.notify('warning', 'Edits discarded - the plan is unchanged.');
      return { plan, edited: false };
    }
    if (op.op === 'done') {
      const next = linesToPlan(lines);
      if (next.trim().length === 0) {
        // Unreachable via the guarded ops; kept so 'done' can never hand an
        // empty plan back to the approval menu.
        io.notify('warning', 'The plan is empty - edit it, or x to discard.');
        continue;
      }
      const edited = next !== plan;
      io.notify(edited ? 'success' : 'info', edited ? 'Plan updated.' : 'No changes made.');
      return { plan: next, edited };
    }
    if (op.op === 'edit') {
      const text = await io.readText(`New text for line ${op.line} (blank keeps it unchanged):`);
      if (text.trim().length === 0) {
        io.notify('info', `Kept line ${op.line} unchanged (use d ${op.line} to delete it).`);
        continue;
      }
      const r = applyEditLine(lines, op.line, text);
      if (!r.ok) io.notify('warning', r.reason);
      else lines = r.lines;
      continue;
    }
    if (op.op === 'delete') {
      const r = applyDeleteLine(lines, op.line);
      if (!r.ok) io.notify('warning', r.reason);
      else lines = r.lines;
      continue;
    }
    // insert
    const text = await io.readText(
      op.line === 0 ? 'New first line (blank cancels):' : `New line after line ${op.line} (blank cancels):`,
    );
    if (text.trim().length === 0) {
      io.notify('info', 'Nothing inserted.');
      continue;
    }
    const r = applyInsertAfter(lines, op.line, text);
    if (!r.ok) io.notify('warning', r.reason);
    else lines = r.lines;
  }
}

/**
 * The [r]evise regeneration payload. Today's payload NEVER carries the prior
 * plan (each revise opens a fresh conversation with only the task + the
 * feedback), so: unedited → the feedback verbatim, byte-identical to 1.7;
 * edited → the EDITED plan rides as the current plan (the model has no other
 * way to see it), with the feedback appended when present.
 */
export function composeReviseFeedback(
  currentPlan: string,
  lastGeneratedPlan: string,
  feedback: string,
): string {
  if (currentPlan === lastGeneratedPlan) return feedback;
  const head = `The user EDITED your previous plan - the CURRENT plan (revise THIS one) is:\n${currentPlan}`;
  return feedback.trim().length > 0 ? `${head}\n\nAdditional feedback: ${feedback}` : head;
}
