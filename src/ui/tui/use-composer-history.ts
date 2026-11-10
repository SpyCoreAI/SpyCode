/**
 * Composer history (up/down through submitted tasks). The index refs live
 * here; the component keeps the returned `historyRef`/`histIdxRef` for its
 * ref-mirror and input-handler writes. Extracted from TuiApp.tsx (M-8);
 * behavior unchanged.
 */
import { useRef } from 'react';
import type { ComposerState } from './editing.js';
import { saveTuiState } from './state.js';

export function useComposerHistory(opts: {
  composerRef: { current: ComposerState };
  updateComposer: (fn: (prev: ComposerState) => ComposerState) => void;
  setHistory: (h: string[]) => void;
}): {
  historyRef: { current: string[] };
  histIdxRef: { current: number };
  pushHistory: (value: string) => void;
  historyBack: () => void;
  historyForward: () => void;
} {
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  const histDraftRef = useRef('');
  const { composerRef, updateComposer, setHistory } = opts;

  const pushHistory = (value: string): void => {
    if (value.trim().length === 0) return;
    const next = [...historyRef.current.slice(-99), value];
    setHistory(next);
    saveTuiState({ draft: '', updatedAt: new Date().toISOString(), history: next });
    histIdxRef.current = -1;
  };

  const historyBack = (): void => {
    const h = historyRef.current;
    if (h.length === 0) return;
    if (histIdxRef.current === -1) {
      histDraftRef.current = composerRef.current.value;
      histIdxRef.current = h.length - 1;
    } else {
      histIdxRef.current = Math.max(0, histIdxRef.current - 1);
    }
    const v = h[histIdxRef.current]!;
    updateComposer(() => ({ value: v, cursor: v.length }));
  };

  const historyForward = (): void => {
    if (histIdxRef.current === -1) return;
    const h = historyRef.current;
    histIdxRef.current += 1;
    if (histIdxRef.current >= h.length) {
      histIdxRef.current = -1;
      const d = histDraftRef.current;
      updateComposer(() => ({ value: d, cursor: d.length }));
    } else {
      const v = h[histIdxRef.current]!;
      updateComposer(() => ({ value: v, cursor: v.length }));
    }
  };
  return { historyRef, histIdxRef, pushHistory, historyBack, historyForward };
}
