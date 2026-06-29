/**
 * Live terminal dimensions with resize handling. Falls back to 80×24 when
 * stdout has no size (non-TTY).
 *
 * Backed by a single shared subscription: no matter how many components call
 * `useTerminalSize`, exactly one `resize` listener is attached to stdout (so we
 * never trip Node's MaxListeners warning).
 */
import { useSyncExternalStore } from 'react';

export interface TerminalSize {
  width: number;
  height: number;
}

function measure(): TerminalSize {
  const { columns, rows } = process.stdout;
  return {
    width: typeof columns === 'number' && columns > 0 ? columns : 80,
    height: typeof rows === 'number' && rows > 0 ? rows : 24,
  };
}

// Module-level store. `snapshot` is a stable reference that only changes when
// the size actually changes — required for useSyncExternalStore correctness.
let snapshot: TerminalSize = measure();
const listeners = new Set<() => void>();
let attached = false;

function handleResize(): void {
  const next = measure();
  if (next.width !== snapshot.width || next.height !== snapshot.height) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
}

function subscribe(onStoreChange: () => void): () => void {
  if (!attached) {
    process.stdout.on('resize', handleResize);
    attached = true;
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && attached) {
      process.stdout.off('resize', handleResize);
      attached = false;
    }
  };
}

function getSnapshot(): TerminalSize {
  return snapshot;
}

export function useTerminalSize(): TerminalSize {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
