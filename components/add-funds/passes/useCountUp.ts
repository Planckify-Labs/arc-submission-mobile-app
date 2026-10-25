import { useEffect, useRef, useState } from "react";

/**
 * Counts a displayed number up to `target` (ease-out, ~0.8 s) when it
 * rises, so a confirmed deposit lands visibly. Drops and the first value
 * apply instantly: a count-up only ever marks money arriving.
 */
export function useCountUp(target: number, durationMs = 800): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const first = useRef(true);

  useEffect(() => {
    if (first.current || target <= shownRef.current) {
      first.current = false;
      shownRef.current = target;
      setShown(target);
      return;
    }
    const from = shownRef.current;
    const start = Date.now();
    let raf = 0;
    const step = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const value = from + (target - from) * (1 - (1 - t) ** 3);
      shownRef.current = value;
      setShown(value);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return shown;
}
