/**
 * A blinking boolean for cursors. Returns `true`/`false` toggling every
 * `intervalMs` while `enabled`; returns `false` (steady, hidden) when disabled.
 */
import { useEffect, useState } from 'react';

export function useBlink(intervalMs = 530, enabled = true): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setOn((o) => !o), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return enabled ? on : false;
}
