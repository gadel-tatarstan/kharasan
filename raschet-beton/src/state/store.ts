import { useSyncExternalStore } from 'react';
import {
  defaultFolderName,
  defaultSlab,
  defaultStrip,
  migrateSlab,
  migrateStrip,
  newId,
  nextProjectName,
  type Folder,
  type Kind,
  type Project,
} from './types';

type State = {
  folders: Folder[];
  projects: Project[];
  currentId: string | null;
};

const KEY = 'beton.projects.v2';
const EMPTY: State = { folders: [], projects: [], currentId: null };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!parsed || !Array.isArray(parsed.projects)) return EMPTY;

    let folders: Folder[] = (Array.isArray(parsed.folders) ? parsed.folders : [])
      .filter((f): f is Folder => !!f && typeof f.id === 'string')
      .map((f) => ({
        id: f.id,
        name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : defaultFolderName,
        createdAt: typeof f.createdAt === 'number' ? f.createdAt : Date.now(),
      }));
    const folderIds = new Set(folders.map((f) => f.id));
    const names: string[] = [];
    const loaded: (Omit<Project, 'folderId'> & { folderId: string | null })[] = [];

    for (const rawProject of parsed.projects) {
      if (!rawProject || typeof rawProject.id !== 'string') continue;
      if (rawProject.kind !== 'slab' && rawProject.kind !== 'strip') continue;
      const p = rawProject as Project;
      // Older strip saves started with a setup screen that no longer exists.
      const next = p.kind === 'strip' && p.stage === 'setup' ? { ...p, stage: 'outline' as const } : p;
      // Older slabs held one contour; older strips kept depth per vertex.
      const migrated: Project =
        next.kind === 'slab'
          ? { ...next, slab: migrateSlab(next.slab) }
          : next.strip
            ? { ...next, strip: migrateStrip(next.strip) }
            : next;
      const fallback = nextProjectName(next.kind, names);
      const name =
        typeof migrated.name === 'string' && migrated.name.trim()
          ? migrated.name.trim()
          : fallback;
      names.push(name);
      loaded.push({
        ...migrated,
        name,
        folderId:
          typeof migrated.folderId === 'string' && folderIds.has(migrated.folderId)
            ? migrated.folderId
            : null,
      });
    }

    // Older saves kept calculations at the root. Move them into one folder so a
    // calculation can never exist outside a folder after upgrading.
    let target: Folder | undefined;
    if (loaded.some((p) => !p.folderId)) {
      target = folders.find((f) => f.name === 'Мои расчёты');
      if (!target) {
        target = { id: newId('f'), name: 'Мои расчёты', createdAt: Date.now() };
        folders = [target, ...folders];
      }
    }
    const projects: Project[] = loaded.map((p) => ({
      ...p,
      folderId: p.folderId ?? target!.id,
    }));

    return {
      folders,
      projects,
      currentId: typeof parsed.currentId === 'string' ? parsed.currentId : null,
    };
  } catch {
    return EMPTY;
  }
}

let state: State = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full / private mode — the app still works in memory */
  }
}

function emit() {
  persist();
  for (const l of listeners) l();
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const getState = () => state;

export function useAppState(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function createProject(kind: Kind, folderId: string): Project {
  const now = Date.now();
  // Every calculation belongs to a folder. If the caller points at a folder
  // that no longer exists, keep the model valid instead of creating an orphan.
  let folders = state.folders;
  let target = folders.find((f) => f.id === folderId);
  if (!target) {
    target = { id: newId('f'), name: uniqueFolderName('Мои расчёты', folders), createdAt: now };
    folders = [target, ...folders];
  }
  const project: Project = {
    id: newId('p'),
    kind,
    stage: 'outline',
    name: nextProjectName(kind, state.projects.map((p) => p.name)),
    folderId: target.id,
    createdAt: now,
    updatedAt: now,
    ...(kind === 'slab' ? { slab: defaultSlab() } : { strip: defaultStrip() }),
  };
  state = { projects: [project, ...state.projects], folders, currentId: project.id };
  emit();
  return project;
}

export function renameProject(id: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  updateProject(id, (p) => ({ ...p, name: clean }));
}

export function moveProject(id: string, folderId: string) {
  if (!state.folders.some((f) => f.id === folderId)) return;
  state = {
    ...state,
    projects: state.projects.map((p) => (p.id === id ? { ...p, folderId } : p)),
  };
  emit();
}

const uniqueFolderName = (base: string, folders: Iterable<Folder>): string => {
  const used = new Set(Array.from(folders).map((f) => f.name));
  let unique = base;
  let n = 2;
  while (used.has(unique)) unique = `${base} ${n++}`;
  return unique;
};

export function createFolder(name: string): Folder {
  const base = name.trim() || defaultFolderName;
  const folder: Folder = {
    id: newId('f'),
    name: uniqueFolderName(base, state.folders),
    createdAt: Date.now(),
  };
  state = { ...state, folders: [folder, ...state.folders] };
  emit();
  return folder;
}

export function renameFolder(id: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  state = {
    ...state,
    folders: state.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)),
  };
  emit();
}

/** Removing a folder also removes every calculation inside it. */
export function deleteFolder(id: string) {
  const doomed = new Set(
    state.projects.filter((p) => p.folderId === id).map((p) => p.id),
  );
  state = {
    ...state,
    folders: state.folders.filter((f) => f.id !== id),
    projects: state.projects.filter((p) => p.folderId !== id),
    currentId:
      state.currentId && doomed.has(state.currentId) ? null : state.currentId,
  };
  emit();
}

export function updateProject(id: string, fn: (p: Project) => Project) {
  state = {
    ...state,
    projects: state.projects.map((p) =>
      p.id === id ? { ...fn(p), updatedAt: Date.now() } : p,
    ),
  };
  emit();
}

export function deleteProject(id: string) {
  state = {
    ...state,
    projects: state.projects.filter((p) => p.id !== id),
    currentId: state.currentId === id ? null : state.currentId,
  };
  emit();
}

export function selectProject(id: string | null) {
  state = { ...state, currentId: id };
  emit();
}

export function duplicateProject(id: string): Project | null {
  const src = state.projects.find((p) => p.id === id);
  if (!src) return null;
  const now = Date.now();
  const copy: Project = {
    ...structuredClone(src),
    id: newId('p'),
    name: nextProjectName(src.kind, state.projects.map((p) => p.name)),
    createdAt: now,
    updatedAt: now,
  };
  state = { ...state, projects: [copy, ...state.projects], currentId: copy.id };
  emit();
  return copy;
}
