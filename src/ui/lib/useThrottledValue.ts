/**
 * Returns `value` but updated at most once per `intervalMs`, always delivering
 * the final value (trailing edge). Used to throttle streaming re-renders so we
 * don't re-lex/re-render Markdown on every token.
 */
import { useEffect, useRef, useState } from 'react';

export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState<T>(value);
  const latest = useRef<T>(value);
  const lastUpdate = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = value;

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdate.current;
    if (elapsed >= intervalMs) {
      lastUpdate.current = now;
      setThrottled(value);
    } else if (timer.current === null) {
      timer.current = setTimeout(() => {
        lastUpdate.current = Date.now();
        timer.current = null;
        setThrottled(latest.current);
      }, intervalMs - elapsed);
    }
  }, [value, intervalMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return throttled;
}
