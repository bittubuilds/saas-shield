import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hold-to-confirm button. A liquid fill rises while the button is pressed and
 * snaps back if the press is released early. The action fires only when the
 * fill reaches the top, so the hold itself is the confirmation.
 *
 * Keyboard: hold Space or Enter. Reduced motion: the fill still tracks the hold
 * (it is the confirmation signal) but the wave and snap-back easing are dropped.
 */
export default function HoldButton({
  children, onConfirm, holdMs = 1200, disabled = false, className = '',
  ariaLabel, busy = false, tone = 'danger',
}) {
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const raf = useRef(0);
  const startedAt = useRef(0);
  const holding = useRef(false);
  const firedRef = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const stop = useCallback((reset) => {
    holding.current = false;
    window.cancelAnimationFrame(raf.current);
    if (reset && !firedRef.current) setProgress(0);
  }, []);

  const tick = useCallback((now) => {
    if (!holding.current) return;
    const p = Math.min(1, (now - startedAt.current) / holdMs);
    setProgress(p);
    if (p >= 1) {
      holding.current = false;
      firedRef.current = true;
      setDone(true);
      onConfirmRef.current && onConfirmRef.current();
      return;
    }
    raf.current = window.requestAnimationFrame(tick);
  }, [holdMs]);

  const start = useCallback(() => {
    if (disabled || busy || holding.current) return;
    firedRef.current = false;
    setDone(false);
    holding.current = true;
    startedAt.current = performance.now();
    raf.current = window.requestAnimationFrame(tick);
  }, [disabled, busy, tick]);

  // Allow another hold once the parent finishes (busy goes back to false).
  useEffect(() => {
    if (!busy && firedRef.current) { firedRef.current = false; setDone(false); setProgress(0); }
  }, [busy]);

  useEffect(() => () => window.cancelAnimationFrame(raf.current), []);

  const onKeyDown = (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); }
  };
  const onKeyUp = (e) => {
    if (e.key === ' ' || e.key === 'Enter') stop(true);
  };

  const pct = Math.round(progress * 100);
  return (
    <button
      type="button"
      className={`hold-btn hold-${tone} ${progress > 0 ? 'is-holding' : ''} ${done ? 'is-done' : ''} ${className}`.trim()}
      style={{ '--hold': progress }}
      disabled={disabled || busy}
      aria-label={ariaLabel}
      aria-valuenow={pct}
      onPointerDown={start}
      onPointerUp={() => stop(true)}
      onPointerLeave={() => stop(true)}
      onPointerCancel={() => stop(true)}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => stop(true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">{children}</span>
    </button>
  );
}
