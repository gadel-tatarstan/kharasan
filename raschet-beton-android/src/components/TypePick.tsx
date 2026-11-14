import type { Kind } from '../state/types';

export function TypePick({
  onPick,
  onBack,
  folderName,
}: {
  onPick: (k: Kind) => void;
  onBack: () => void;
  folderName?: string;
}) {
  return (
    <div className="typepick">
      <header className="ed-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Назад">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="ed-head__titles">
          <div className="ed-head__title">Что заливаем?</div>
          <div className="ed-head__subtitle">
            {folderName ? `в папке «${folderName}»` : 'выберите тип конструкции'}
          </div>
        </div>
        <span className="icon-btn icon-btn--ghost" />
      </header>

      <div className="typepick__body">
        <button type="button" className="typecard" onClick={() => onPick('slab')}>
          <span className="typecard__art" aria-hidden>
            <svg viewBox="0 0 200 140" width="100%" height="100%">
              <path d="M30 92 100 60l70 32-70 26z" fill="rgba(255,122,47,.18)" stroke="#ff8a4c" strokeWidth="2" strokeLinejoin="round" />
              <path d="M30 92V74l70-30 70 30v18" fill="none" stroke="rgba(255,138,76,.45)" strokeWidth="2" strokeDasharray="6 6" />
              {[
                [30, 92],
                [100, 60],
                [170, 92],
                [100, 118],
              ].map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r="4" fill="#ffb27a" />
              ))}
            </svg>
          </span>
          <span className="typecard__title">Плита</span>
          <span className="typecard__desc">
            Площадка, пол, перекрытие. Любая многоугольная форма, толщина с уклоном.
          </span>
          <span className="typecard__cta">Нарисовать контур →</span>
        </button>

        <button type="button" className="typecard" onClick={() => onPick('strip')}>
          <span className="typecard__art" aria-hidden>
            <svg viewBox="0 0 200 140" width="100%" height="100%">
              <path d="M34 44h70v56h62" fill="none" stroke="rgba(255,122,47,.22)" strokeWidth="30" strokeLinejoin="round" />
              <path d="M34 44h70v56h62" fill="none" stroke="#ff8a4c" strokeWidth="2" strokeDasharray="6 6" strokeLinejoin="round" />
              {[
                [34, 44],
                [104, 44],
                [104, 100],
                [166, 100],
              ].map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r="4" fill="#ffb27a" />
              ))}
            </svg>
          </span>
          <span className="typecard__title">Лента</span>
          <span className="typecard__desc">
            Фундамент, ростверк. Разомкнутая или кольцо, ответвления, своя ширина у каждого участка.
          </span>
          <span className="typecard__cta">Задать ширину и рисовать →</span>
        </button>
      </div>
      <p className="home__note typepick__note">
        Контур сразу выпрямится: углы станут 90°, линии — параллельными или перпендикулярными.
      </p>
    </div>
  );
}
