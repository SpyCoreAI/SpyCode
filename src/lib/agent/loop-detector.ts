/**
 * A-2 - tiered loop detector: repetition / wandering guard for the agent loop.
 *
 * SpyCode used to guard only the empty completion. A model stuck in a
 * no-progress loop (same tool call over and over, re-reading an unchanged
 * file, or wandering for turns without changing anything) burned the whole
 * turn budget silently. This module watches the turn trace and answers in
 * three escalating steps, exactly like the reference design:
 *
 *   warn  -> an in-band notice telling the model it is repeating itself;
 *   veto  -> a stronger synthetic guidance: do NOT repeat the call, name the
 *            concrete different thing to do instead (summarize and finish);
 *   breaker -> end the run gracefully. The session stays healthy (the journal
 *            is persisted); only the looping stops.
 *
 * Terminal verbs are never gated: a turn that produced a final answer has no
 * tool calls, and the detector stays silent on it.
 */
import { createHash } from 'node:crypto';

/** One dispatched call the loop observed this turn. */
export interface LoopCallTrace {
  tool: string;
  /** Stable rendering of the call's arguments. */
  argsKey: string;
  ok: boolean;
  /** The (capped) result content fed back to the model. */
  content: string;
  /** True for tools that change the workspace. */
  mutating: boolean;
}

export interface TurnTrace {
  turn: number;
  calls: LoopCallTrace[];
}

export type LoopLevel = 'none' | 'warn' | 'veto' | 'breaker';

export interface LoopVerdict {
  level: LoopLevel;
  /** Model-facing text for warn/veto; the graceful-stop note for breaker. */
  notice: string | null;
  /** Machine-readable reason, for the event stream. */
  reason: string;
}

/** Consecutive identical turn signatures before each step. */
export const LOOP_WARN_REPEATS = 2;
export const LOOP_VETO_REPEATS = 3;
export const LOOP_BREAKER_REPEATS = 4;
/** Turns with no mutating success and no new information before wandering fires. */
export const LOOP_WANDER_WARN_TURNS = 8;
export const LOOP_WANDER_VETO_TURNS = 12;

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface LoopDetector {
  observeTurn(trace: TurnTrace): LoopVerdict;
}

export function createLoopDetector(): LoopDetector {
  // Consecutive turns with the exact same call signature.
  let repeatStreak = 0;
  let lastSignature: string | null = null;
  // Re-reads of a path whose content did not change and nothing wrote since.
  const lastReadHash = new Map<string, string>();
  let readRepeatStreak = 0;
  // Wandering: turns since the last sign of progress (a successful mutating
  // call, or a successful call whose result content was new).
  let turnsSinceProgress = 0;
  const seenContent = new Set<string>();
  let wanderWarned = false;
  let wanderVetoed = false;
  // The escalator latches: once the veto fired for a streak, the next
  // identical observation is the breaker - a model that ignores the veto
  // does not get a second veto.
  let vetoFiredForStreak = false;

  const signatureOf = (calls: LoopCallTrace[]): string =>
    calls.map((c) => `${c.tool}(${c.argsKey})`).join('|');

  return {
    observeTurn(trace: TurnTrace): LoopVerdict {
      const none: LoopVerdict = { level: 'none', notice: null, reason: 'none' };
      // A final-answer turn has no tool calls - terminal verbs are never gated.
      if (trace.calls.length === 0) {
        turnsSinceProgress = 0;
        return none;
      }

      let repeated = false;
      const signature = signatureOf(trace.calls);
      if (lastSignature !== null && signature === lastSignature) {
        repeatStreak += 1;
        repeated = true;
      } else {
        repeatStreak = 0;
        vetoFiredForStreak = false;
      }
      lastSignature = signature;

      // File re-read without change: read_file on a path whose content hash
      // matches the last read AND no mutating call happened in between. A
      // mutating call may have changed the file, so any of them clears the map.
      let sawMutatingSuccess = false;
      for (const c of trace.calls) {
        if (c.mutating) {
          lastReadHash.clear();
          if (c.ok) sawMutatingSuccess = true;
          continue;
        }
        if (c.tool === 'read_file' && c.ok) {
          const h = contentHash(c.content);
          const prev = lastReadHash.get(c.argsKey);
          if (prev !== undefined && prev === h) {
            readRepeatStreak += 1;
            repeated = true;
          } else {
            lastReadHash.set(c.argsKey, h);
          }
        }
      }
      if (!repeated) readRepeatStreak = Math.max(0, readRepeatStreak - 1);

      // Progress: a successful mutation, or a successful result whose content
      // the run has not seen before.
      let newInformation = false;
      for (const c of trace.calls) {
        if (!c.ok) continue;
        const h = contentHash(c.content);
        if (!seenContent.has(h)) {
          seenContent.add(h);
          newInformation = true;
        }
      }
      if (sawMutatingSuccess || newInformation) {
        turnsSinceProgress = 0;
        wanderWarned = false;
        wanderVetoed = false;
      } else {
        turnsSinceProgress += 1;
      }

      const repeats = Math.max(repeatStreak, readRepeatStreak);
      if (repeats >= LOOP_BREAKER_REPEATS || (vetoFiredForStreak && repeated)) {
        return {
          level: 'breaker',
          notice:
            'Stopped: the agent repeated the same tool call(s) without making progress ' +
            `(${repeats} identical turns in a row). The session is intact - re-run with a narrower task or intervene.`,
          reason: 'repetition_breaker',
        };
      }
      if (repeats >= LOOP_VETO_REPEATS) {
        vetoFiredForStreak = true;
        return {
          level: 'veto',
          notice:
            '[loop-detector veto] You are repeating the same tool call(s) with no new result. ' +
            'Do NOT issue the same call again. Write a brief summary of what you learned so far ' +
            'and give your final answer now as plain text.',
          reason: 'repetition_veto',
        };
      }
      if (repeats >= LOOP_WARN_REPEATS) {
        return {
          level: 'warn',
          notice:
            '[loop-detector] You have repeated the same tool call(s) with no new result. ' +
            'Stop repeating: either try a genuinely different approach or summarize and give your final answer.',
          reason: 'repetition_warn',
        };
      }
      if (turnsSinceProgress >= LOOP_WANDER_VETO_TURNS && !wanderVetoed) {
        wanderVetoed = true;
        return {
          level: 'veto',
          notice:
            `[loop-detector veto] ${turnsSinceProgress} turns with no file changes and no new information - ` +
            'you are wandering. Do NOT continue exploring. Summarize what you know and give your final answer now as plain text.',
          reason: 'wandering_veto',
        };
      }
      if (turnsSinceProgress >= LOOP_WANDER_WARN_TURNS && !wanderWarned) {
        wanderWarned = true;
        return {
          level: 'warn',
          notice:
            `[loop-detector] ${turnsSinceProgress} turns with no file changes and no new information. ` +
            'Refocus on the TASK: name the single next concrete step, or summarize and give your final answer.',
          reason: 'wandering_warn',
        };
      }
      return none;
    },
  };
}
