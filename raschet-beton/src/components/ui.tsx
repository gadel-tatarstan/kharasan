import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fmtM2, fmtM3, fmtMm, fmtSize, parseNum } from '../lib/format';

export function Btn({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  full,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'soft' | 'danger';
  disabled?: boolean;
  full?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}${full ? ' btn--full' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={`segmented__item${value === o.value ? ' is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NumberField({
  label,
  value,
  unit = 'мм',
  onChange,
  min = 10,
  max = 100000,
  step,
  hint,
  signed,
  fieldKey,
}: {
  label: string;
  value: number;
  unit?: string;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** Accepts a minus sign, for values measured from a reference edge. */
  signed?: boolean;
  /** Lets a label on the canvas find and highlight this exact field. */
  fieldKey?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? fmtMm(value);

  const commit = (raw: string) => {
    const parsed = parseNum(raw, signed);
    setDraft(null);
    if (parsed === null) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <div className="field" data-offset-field={fieldKey}>
      <span className="field__label">{label}</span>
      <div className="field__box">
        {step ? (
          <button
            type="button"
            className="stepper"
            aria-label="меньше"
            onClick={() => onChange(Math.max(min, value - step))}
          >
            −
          </button>
        ) : null}
        {signed ? (
          <button
            type="button"
            className="stepper"
            aria-label="Сменить знак"
            onClick={() => onChange(-value)}
          >
            ±
          </button>
        ) : null}
        <input
          className="field__input"
          inputMode="decimal"
          enterKeyHint="done"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            // The "done" key on a numeric Android keyboard may report either a
            // named Enter or keyCode 13; both must fold the keyboard away.
            if (e.key === 'Enter' || e.keyCode === 13) {
              e.preventDefault();
              e.currentTarget.blur();
              // The sheet re-renders right after the value is committed; if the
              // WebView restores focus to the input, blur it again once more.
              window.setTimeout(() => {
                const el = document.activeElement;
                if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                  el.blur();
                }
              }, 80);
            }
          }}
          onFocus={(e) => e.target.select()}
        />
        <span className="field__unit">{unit}</span>
        {step ? (
          <button
            type="button"
            className="stepper"
            aria-label="больше"
            onClick={() => onChange(Math.min(max, value + step))}
          >
            +
          </button>
        ) : null}
      </div>
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

/**
 * A labelled on/off switch. It is a button rather than a checkbox so the whole
 * row is tappable on a phone and the state reads at a glance.
 */
export function Switch({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__text">
        <span className="switch__label">{label}</span>
        {hint && <span className="switch__hint">{hint}</span>}
      </span>
      <span className="switch__track" aria-hidden>
        <span className="switch__thumb" />
      </span>
    </button>
  );
}

export function EditorHeader({
  title,
  subtitle,
  onBack,
  onInfo,
  onRename,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
  onInfo: () => void;
  /** Tapping the name opens the rename dialog; the pencil is the affordance. */
  onRename?: () => void;
}) {
  const titles = (
    <>
      <span className="ed-head__title">
        {title}
        {onRename && (
          <svg className="ed-head__pencil" viewBox="0 0 24 24" width="12" height="12" aria-hidden>
            <path
              d="m4 20 4.5-1.1 9-9a2.1 2.1 0 0 0-3-3l-9 9zM13.8 6.6l3.6 3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="ed-head__subtitle">{subtitle}</span>
    </>
  );
  return (
    <header className="ed-head">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="Назад">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {onRename ? (
        <button
          type="button"
          className="ed-head__titles ed-head__titles--button"
          onClick={onRename}
          aria-label="Переименовать расчёт"
        >
          {titles}
        </button>
      ) : (
        <div className="ed-head__titles">{titles}</div>
      )}
      <button type="button" className="icon-btn" onClick={onInfo} aria-label="Как это работает">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 11v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="7.8" r="1.15" fill="currentColor" />
        </svg>
      </button>
    </header>
  );
}

export function VolumeHud({
  volumeMm3,
  areaMm2,
  avgThickness,
  kind,
  ready,
  strips,
  size,
  toothVolumeMm3,
}: {
  volumeMm3: number;
  areaMm2: number;
  avgThickness: number;
  kind: 'slab' | 'strip';
  ready: boolean;
  strips?: { center: number; outer: number; inner: number };
  size?: { w: number; h: number } | null;
  /** Part of the volume contributed by the apron tooth, mm³. */
  toothVolumeMm3?: number;
}) {
  const [pulse, setPulse] = useState(0);
  const prev = useRef(volumeMm3);
  useEffect(() => {
    if (Math.abs(prev.current - volumeMm3) > 0.5) {
      prev.current = volumeMm3;
      setPulse((p) => p + 1);
    }
  }, [volumeMm3]);

  if (!ready) {
    return (
      <div className="hud hud--idle">
        <div className="hud__label">Объём</div>
        <div className="hud__empty">Введите длину любого отрезка</div>
      </div>
    );
  }

  return (
    <div className="hud">
      <div className="hud__main">
        <div className="hud__label">Объём бетона</div>
        <div className="hud__value" key={pulse}>
          {fmtM3(volumeMm3)}
          <span className="hud__unit">м³</span>
        </div>
      </div>
      <div className="hud__side">
        {size && (
          <span
            className="scene-size"
            title="Габариты полезной площади: ширина × высота"
            aria-label={`Габариты ${fmtSize(size.w)} на ${fmtSize(size.h)} метров`}
          >
            {fmtSize(size.w)} × {fmtSize(size.h)} м
          </span>
        )}
        <div className="hud__meta">
          {kind === 'slab' ? (
            <>
              Площадь <span className="hud__num">{fmtM2(areaMm2)}</span> м² · ср.{' '}
              <span className="hud__num">{fmtMm(avgThickness)}</span> мм
            </>
          ) : (
            <>
              Длина оси <span className="hud__num">{fmtMm(strips?.center ?? 0)}</span> мм
              {strips && Math.abs(strips.outer - strips.inner) > 1 && (
                <>
                  {' '}
                  · по откосам{' '}
                  <span className="hud__num">
                    {fmtMm(strips.inner)}…{fmtMm(strips.outer)}
                  </span>
                </>
              )}
              {toothVolumeMm3 !== undefined && toothVolumeMm3 > 0 && (
                <>
                  {' '}
                  · зуб <span className="hud__num">{fmtM3(toothVolumeMm3)}</span> м³
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const SheetState = createContext<{ open: boolean; toggle: () => void } | null>(null);

/**
 * The sheet's tab row: the mode tabs plus a round collapse/expand button.
 * Keeping the button on the tabs line saves the height the old wide grip used
 * and leaves the panel edges clean.
 */
export function SheetTabs({ children }: { children: React.ReactNode }) {
  const sheet = useContext(SheetState);
  return (
    <div className="sheet__tabs">
      {children}
      <button
        type="button"
        className="sheet__toggle"
        onClick={() => sheet?.toggle()}
        aria-expanded={sheet?.open ?? true}
        aria-label={sheet?.open ? 'Свернуть панель' : 'Развернуть панель'}
        title={sheet?.open ? 'Свернуть панель' : 'Развернуть панель'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          {sheet?.open ? (
            <path
              d="M6 9.5 12 15l6-5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <path
              d="M6 14.5 12 9l6 5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </button>
    </div>
  );
}

/**
 * Collapsible bottom sheet. On a phone it is capped by CSS to roughly a third
 * of the screen and scrolls on its own; the round button on the tab row folds
 * it down to just those tabs so the drawing gets almost the whole viewport.
 */
export function EditorSheet({
  children,
  expandSignal,
}: {
  children: React.ReactNode;
  /** Bump this to unfold the sheet, e.g. when a canvas label is tapped. */
  expandSignal?: number;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (expandSignal) setOpen(true);
  }, [expandSignal]);
  return (
    <SheetState.Provider value={{ open, toggle: () => setOpen((v) => !v) }}>
      <div className={`sheet${open ? '' : ' is-collapsed'}`}>{children}</div>
    </SheetState.Provider>
  );
}

/** In-app confirmation, styled like the help sheet instead of a native alert. */
export function ConfirmDialog({
  title,
  text,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  text: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__backdrop" onClick={onCancel} />
      <div className="modal__panel confirm">
        <div className="modal__grip" />
        <h2 className="modal__title">{title}</h2>
        <p className="confirm__text">{text}</p>
        <div className="confirm__actions">
          <Btn onClick={onCancel}>{cancelLabel}</Btn>
          <Btn variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** One-field dialog shared by renaming a calculation and naming a folder. */
export function NameDialog({
  title,
  label,
  initial,
  placeholder,
  confirmLabel = 'Сохранить',
  onConfirm,
  onCancel,
}: {
  title: string;
  label: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const clean = value.trim();

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => {
    if (clean) onConfirm(clean);
  };

  return (
    <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__backdrop" onClick={onCancel} />
      <div className="modal__panel confirm">
        <div className="modal__grip" />
        <h2 className="modal__title">{title}</h2>
        <label className="nameform">
          <span className="field__label">{label}</span>
          <input
            ref={inputRef}
            className="modal__input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="confirm__actions">
          <Btn onClick={onCancel}>Отмена</Btn>
          <Btn variant="primary" onClick={submit} disabled={!clean}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Alerts stay until dismissed: a cross closes them, and a press anywhere
  // outside does the same without stealing the press from the screen below.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onDone();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onDone]);

  return (
    <div className="toast" role="alert" ref={ref}>
      <span className="toast__icon">!</span>
      <span className="toast__text">{text}</span>
      <button type="button" className="toast__close" aria-label="Закрыть сообщение" onClick={onDone}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
          <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
