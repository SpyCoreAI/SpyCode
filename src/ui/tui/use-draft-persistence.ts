/**
 * Draft persistence (debounced): drafts are never lost, and a manually-cleared
 * draft persists as empty rather than resurrecting stale text. Extracted from
 * TuiApp.tsx (M-8); behavior unchanged.
 */
import { useEffect } from 'react';
import { saveTuiState } from './state.js';

export function useDraftPersistence(
  composerValue: string,
  composerRef: { current: { value: string } },
  historyRef: { current: string[] },
): void {
  useEffect(() => {
    const t = setTimeout(() => {
      saveTuiState({
        draft: composerRef.current.value,
        updatedAt: new Date().toISOString(),
        history: historyRef.current,
      });
    }, 800);
    return () => clearTimeout(t);
  }, [composerValue]);
}
