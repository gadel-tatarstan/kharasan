import { useState } from 'react';
import { projectVolume } from '../state/derive';
import type { Folder, Project } from '../state/types';
import { fmtM3 } from '../lib/format';
import { Btn, ConfirmDialog } from './ui';

function KindIcon({ kind }: { kind: 'slab' | 'strip' }) {
  return (
    <span className={`kind-icon kind-icon--${kind}`} aria-hidden>
      <svg viewBox="0 0 32 32" width="22" height="22">
        {kind === 'slab' ? (
          <path d="M5 11 16 5l11 6v10l-11 6-11-6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        ) : (
          <>
            <path d="M4 22V9h10v13h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M4 18h10M10 9v-4" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
          </>
        )}
      </svg>
    </span>
  );
}

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
    <path
      d="M3.5 7.5h6l1.8 2h9.2v8.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="M3.5 9.5v-2A1.5 1.5 0 0 1 5 6h3.2l1.6 1.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

const BackIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
    <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MoreIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <circle cx="6" cy="12" r="1.6" fill="currentColor" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    <circle cx="18" cy="12" r="1.6" fill="currentColor" />
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path d="M9.5 6 15 12l-5.5 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const dateLabel = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) +
    ', ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

export function Home({
  folders,
  projects,
  openFolderId,
  onOpenFolder,
  onNewProject,
  onOpen,
  onDeleteProject,
  onMoveProject,
  onRenameProject,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  onInfo,
}: {
  folders: Folder[];
  projects: Project[];
  openFolderId: string | null;
  onOpenFolder: (id: string | null) => void;
  onNewProject: (folderId: string) => void;
  onOpen: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onMoveProject: (id: string, folderId: string) => void;
  onRenameProject: (project: Project) => void;
  onNewFolder: () => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onInfo: () => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [pendingFolder, setPendingFolder] = useState<Folder | null>(null);
  const [menuFor, setMenuFor] = useState<Project | null>(null);
  const [folderMenu, setFolderMenu] = useState<Folder | null>(null);
  const [moveFor, setMoveFor] = useState<Project | null>(null);

  const openFolder = folders.find((f) => f.id === openFolderId) ?? null;
  const inFolder = (folder: Folder) => projects.filter((p) => p.folderId === folder.id);

  const folderMeta = (folder: Folder) => {
    const items = inFolder(folder);
    if (items.length === 0) return 'Пока пусто';
    let mm3 = 0;
    for (const p of items) {
      const vol = projectVolume(p);
      if (vol.ready) mm3 += vol.mm3;
    }
    const count = `${items.length} ${plural(items.length, 'расчёт', 'расчёта', 'расчётов')}`;
    return mm3 > 0 ? `${count} · ${fmtM3(mm3)} м³` : count;
  };

  const card = (p: Project) => {
    const vol = projectVolume(p);
    return (
      <li key={p.id}>
        <div className="card">
          <button type="button" className="card__main" onClick={() => onOpen(p.id)}>
            <KindIcon kind={p.kind} />
            <span className="card__text">
              <span className="card__title">{p.name}</span>
              <span className="card__meta">{dateLabel(p.updatedAt)}</span>
            </span>
            <span className="card__vol">
              {vol.ready ? fmtM3(vol.mm3) : '—'}
              <span className="card__vol-unit">м³</span>
            </span>
          </button>
          <button
            type="button"
            className="card__act"
            aria-label={`Действия: ${p.name}`}
            onClick={() => setMenuFor(p)}
          >
            <MoreIcon />
          </button>
        </div>
      </li>
    );
  };

  const folderCard = (f: Folder) => (
    <li key={f.id}>
      <div className="card card--folder folder-card">
        <button type="button" className="card__main" onClick={() => onOpenFolder(f.id)}>
          <span className="kind-icon" aria-hidden>
            <FolderIcon />
          </span>
          <span className="card__text">
            <span className="card__title">{f.name}</span>
            <span className="card__meta">{folderMeta(f)}</span>
          </span>
          <span className="folder-card__chevron" aria-hidden>
            <ChevronIcon />
          </span>
        </button>
      </div>
    </li>
  );

  return (
    <div className="home">
      {openFolder ? (
        <>
          <div className="fview__head">
            <button
              type="button"
              className="icon-btn"
              aria-label="Назад к папкам"
              onClick={() => onOpenFolder(null)}
            >
              <BackIcon />
            </button>
            <div className="fview__titles">
              <span className="fview__name">{openFolder.name}</span>
              <span className="fview__meta">{folderMeta(openFolder)}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Действия: папка ${openFolder.name}`}
              onClick={() => setFolderMenu(openFolder)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                <circle cx="6" cy="12" r="1.7" fill="currentColor" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
                <circle cx="18" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </button>
          </div>

          <button
            type="button"
            className="addcalc"
            onClick={() => onNewProject(openFolder.id)}
          >
            <span className="addcalc__plus" aria-hidden>
              +
            </span>
            <span className="addcalc__text">
              <b>Новый расчёт</b>
              <span>плита или лента — нарисуйте контур пальцем</span>
            </span>
            <span className="addcalc__arrow" aria-hidden>
              →
            </span>
          </button>

          {inFolder(openFolder).length > 0 ? (
            <ul className="list">{inFolder(openFolder).map(card)}</ul>
          ) : (
            <p className="fview__empty">Здесь появятся расчёты этой папки.</p>
          )}
        </>
      ) : (
        <>
          <div className="home__head">
            <div className="brand">
              <span className="brand__mark" aria-hidden>
                <svg viewBox="0 0 40 40" width="40" height="40">
                  <rect width="40" height="40" rx="11" fill="#ff7a2f" />
                  <path d="M20 8 32 14.5v11L20 32 8 25.5v-11z" fill="#1a0d03" opacity="0.85" />
                  <path d="M20 8 32 14.5 20 21 8 14.5z" fill="#ffd9c0" />
                </svg>
              </span>
              <div>
                <h1 className="brand__title">Бетон</h1>
                <p className="brand__sub">объём по контуру — офлайн</p>
              </div>
            </div>
            <button type="button" className="icon-btn" onClick={onInfo} aria-label="Как это работает">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M12 11v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="12" cy="7.8" r="1.15" fill="currentColor" />
              </svg>
            </button>
          </div>

          {folders.length === 0 ? (
            <div className="empty empty--cta">
              <div className="empty__art" aria-hidden>
                <svg viewBox="0 0 120 90" width="150" height="112">
                  <path d="M20 60 60 40l40 20-40 20z" fill="rgba(255,122,47,.16)" stroke="#ff8a4c" strokeWidth="1.6" />
                  <path d="M20 60v-14l40-20 40 20v14" fill="none" stroke="rgba(255,138,76,.5)" strokeWidth="1.6" strokeDasharray="5 5" />
                  {[20, 60, 100].map((x, i) => (
                    <circle key={i} cx={x} cy={i === 1 ? 40 : 60} r="3.2" fill="#ffb27a" />
                  ))}
                </svg>
              </div>
              <p>Расчёты хранятся в папках. Создайте первую — например, «Дом» или «Участок».</p>
              <Btn variant="primary" full onClick={onNewFolder}>
                Создать папку
              </Btn>
            </div>
          ) : (
            <>
              <div className="section-head">
                <span>Папки</span>
                <span className="section-head__count">{folders.length}</span>
                <button type="button" className="section-head__add" onClick={onNewFolder}>
                  + Папка
                </button>
              </div>
              <ul className="list">{folders.map(folderCard)}</ul>
            </>
          )}
        </>
      )}

      <div className="home__foot">
        <p className="home__note">
          Всё хранится только на этом устройстве. Интернет не нужен, данные никуда не уходят.
        </p>
      </div>

      {menuFor && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Действия с расчётом">
          <div className="modal__backdrop" onClick={() => setMenuFor(null)} />
          <div className="modal__panel actions">
            <div className="modal__grip" />
            <div className="actions__head">{menuFor.name}</div>
            <button
              type="button"
              className="action"
              onClick={() => {
                const p = menuFor;
                setMenuFor(null);
                onRenameProject(p);
              }}
            >
              Переименовать
            </button>
            {folders.length > 1 && (
              <button
                type="button"
                className="action"
                onClick={() => {
                  setMoveFor(menuFor);
                  setMenuFor(null);
                }}
              >
                Переместить в другую папку
              </button>
            )}
            <button
              type="button"
              className="action action--danger"
              onClick={() => {
                setPendingDelete(menuFor);
                setMenuFor(null);
              }}
            >
              Удалить расчёт
            </button>
          </div>
        </div>
      )}

      {folderMenu && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Действия с папкой">
          <div className="modal__backdrop" onClick={() => setFolderMenu(null)} />
          <div className="modal__panel actions">
            <div className="modal__grip" />
            <div className="actions__head">{folderMenu.name}</div>
            <button
              type="button"
              className="action"
              onClick={() => {
                const f = folderMenu;
                setFolderMenu(null);
                onRenameFolder(f);
              }}
            >
              Переименовать папку
            </button>
            <button
              type="button"
              className="action action--danger"
              onClick={() => {
                setPendingFolder(folderMenu);
                setFolderMenu(null);
              }}
            >
              Удалить папку
            </button>
          </div>
        </div>
      )}

      {moveFor && (
        <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label="Переместить расчёт">
          <div className="modal__backdrop" onClick={() => setMoveFor(null)} />
          <div className="modal__panel confirm">
            <div className="modal__grip" />
            <h2 className="modal__title">Переместить расчёт</h2>
            <p className="confirm__text">{moveFor.name}</p>
            <div className="folderpick">
              {folders
                .filter((f) => f.id !== moveFor.folderId)
                .map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    className="pickrow"
                    onClick={() => {
                      onMoveProject(moveFor.id, f.id);
                      setMoveFor(null);
                    }}
                  >
                    {f.name}
                  </button>
                ))}
            </div>
            <div className="confirm__actions">
              <Btn onClick={() => setMoveFor(null)}>Отмена</Btn>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Удалить расчёт?"
          text={`«${pendingDelete.name}» будет удалён с этого устройства. Отменить это действие нельзя.`}
          confirmLabel="Удалить"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDeleteProject(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      )}

      {pendingFolder && (
        <ConfirmDialog
          title="Удалить папку?"
          text={
            inFolder(pendingFolder).length
              ? `«${pendingFolder.name}» и все расчёты внутри (${inFolder(pendingFolder).length}) будут удалены с этого устройства. Отменить это действие нельзя.`
              : `«${pendingFolder.name}» будет удалена. Расчётов внутри нет.`
          }
          confirmLabel="Удалить всё"
          danger
          onCancel={() => setPendingFolder(null)}
          onConfirm={() => {
            onDeleteFolder(pendingFolder);
            setPendingFolder(null);
            onOpenFolder(null);
          }}
        />
      )}
    </div>
  );
}
