import { useEffect, useRef, useState } from 'react';
import { fmtMm, parseNum } from '../lib/format';
import { isCanvasGestureActive, onCanvasGestureStart } from '../lib/gesture';

type Tone = 'default' | 'ref' | 'pinned' | 'thickness' | 'muted' | 'width';

type Props = {
  x: number;
  y: number;
  value: number | null;
  unit?: string;
  tone?: Tone;
  placeholder?: string;
  label?: string;
  compact?: boolean;
  active?: boolean;
  editable?: boolean;
  /** Visual scale so dense plans can shrink numbers instead of hiding them. */
  scale?: number;
  onCommit?: (v: number) => void;
  onRef?: () => void;
  onTap?: () => void;
  /** Marks this face as picked before its number is edited. */
  onSelect?: () => void;
  refHint?: boolean;
};

const STOP = (e: React.PointerEvent) => e.stopPropagation();

/** A press that travels further than this is a pan, not a tap. */
const DRAG_SLOP = 10;

export function Chip({
  x,
  y,
  value,
  unit = 'мм',
  tone = 'default',
  placeholder = 'мм',
  label,
  compact,
  active,
  editable = true,
  scale = 1,
  onCommit,
  onRef,
  onTap,
  onSelect,
  refHint,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const timer = useRef<number | null>(null);
  const longFired = useRef(false);
  const moved = useRef(false);
  const closing = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editing]);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  // The canvas claimed the press: never pin and never open the editor.
  useEffect(
    () =>
      onCanvasGestureStart(() => {
        clearTimer();
        moved.current = true;
      }),
    [],
  );

  const start = (e: React.PointerEvent) => {
    // Do not stop propagation: the same press may become a canvas pan. The
    // canvas listens in the capture phase and decides by movement.
    longFired.current = false;
    origin.current = { x: e.clientX, y: e.clientY };
    clearTimer();
    // The canvas sees every pointer in the capture phase, so a second finger
    // landing on a number has already started a pinch. This press belongs to
    // that gesture: arming a long press here used to toggle the green pin in
    // the middle of a zoom.
    if (isCanvasGestureActive()) {
      moved.current = true;
      return;
    }
    moved.current = false;
    if (!onRef) return;
    timer.current = window.setTimeout(() => {
      longFired.current = true;
      onRef();
      if (navigator.vibrate) navigator.vibrate(12);
    }, 480);
  };

  const end = () => {
    clearTimer();
    origin.current = null;
  };

  const move = (e: React.PointerEvent) => {
    const from = origin.current;
    if (!from) return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP) {
      moved.current = true;
      clearTimer();
    }
  };

  const click = () => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    if (onTap) {
      onTap();
      return;
    }
    onSelect?.();
    if (!editable || !onCommit) return;
    closing.current = false;
    setDraft(value === null ? '' : String(Math.round(value)));
    setEditing(true);
  };

  const commit = () => {
    // Removing the input while the soft keyboard is up is not enough on Android:
    // it stays over the plan. Blur first so the keyboard folds away immediately.
    if (closing.current) return;
    closing.current = true;
    const parsed = parseNum(draft);
    inputRef.current?.blur();
    setEditing(false);
    if (parsed !== null && parsed > 0) onCommit?.(parsed);
  };

  return (
    <div
      className={`chip chip--${tone}${active ? ' is-active' : ''}${compact ? ' chip--compact' : ''}`}
      style={{
        left: x,
        top: y,
        transform: `translate(-50%, -50%) scale(${scale})`,
      }}
      onPointerDown={start}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onPointerMove={move}
    >
      {label && <span className="chip__label">{label}</span>}
      {editing ? (
        <input
          ref={inputRef}
          className="chip__input"
          data-canvas-ignore
          inputMode="decimal"
          enterKeyHint="done"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onPointerDown={STOP}
        />
      ) : (
        <button type="button" className="chip__btn" onClick={click}>
          <span className="chip__value">{value === null ? placeholder : fmtMm(value)}</span>
          {value !== null && unit && <span className="chip__unit">{unit}</span>}
        </button>
      )}
      {(tone === 'ref' || tone === 'pinned') && <span className="chip__dot" aria-hidden />}
      {refHint && !active && <span className="chip__hint" aria-hidden />}
    </div>
  );
}
