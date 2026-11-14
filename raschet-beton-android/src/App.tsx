import { useState } from 'react';
import {
  createFolder,
  createProject,
  deleteFolder,
  deleteProject,
  moveProject,
  renameFolder,
  renameProject,
  selectProject,
  updateProject,
  useAppState,
} from './state/store';
import type { Folder, Project } from './state/types';
import { Home } from './components/Home';
import { TypePick } from './components/TypePick';
import { SlabEditor } from './components/SlabEditor';
import { StripEditor } from './components/StripEditor';
import { InfoSheet } from './components/InfoSheet';
import { NameDialog } from './components/ui';

type Naming =
  | { target: 'project'; id: string; title: string; label: string; initial: string }
  | { target: 'folder'; id: string; title: string; label: string; initial: string }
  | { target: 'new-folder'; title: string; label: string; initial: string };

export default function App() {
  const { folders, projects, currentId } = useAppState();
  // Creation starts inside a folder, so this holds the folder the new
  // calculation will belong to rather than a plain on/off flag.
  const [picking, setPicking] = useState<string | null>(null);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [naming, setNaming] = useState<Naming | null>(null);
  const current = projects.find((p) => p.id === currentId) ?? null;

  const update = (fn: (p: Project) => Project) => {
    if (current) updateProject(current.id, fn);
  };

  const requestProjectName = (project: Project) =>
    setNaming({
      target: 'project',
      id: project.id,
      title: 'Название расчёта',
      label: 'Как назвать расчёт',
      initial: project.name,
    });

  const requestFolderName = (folder: Folder) =>
    setNaming({
      target: 'folder',
      id: folder.id,
      title: 'Название папки',
      label: 'Как назвать папку',
      initial: folder.name,
    });

  const requestNewFolder = () =>
    setNaming({
      target: 'new-folder',
      title: 'Новая папка',
      label: 'Название папки',
      initial: '',
    });

  const confirmName = (value: string) => {
    if (!naming) return;
    if (naming.target === 'project') renameProject(naming.id, value);
    else if (naming.target === 'folder') renameFolder(naming.id, value);
    else setOpenFolderId(createFolder(value).id);
    setNaming(null);
  };

  return (
    <div className="app">
      {current ? (
        current.kind === 'slab' ? (
          <SlabEditor
            key={current.id}
            project={current}
            update={update}
            onBack={() => selectProject(null)}
            onInfo={() => setInfo(true)}
            onRename={() => requestProjectName(current)}
          />
        ) : (
          <StripEditor
            key={current.id}
            project={current}
            update={update}
            onBack={() => selectProject(null)}
            onInfo={() => setInfo(true)}
            onRename={() => requestProjectName(current)}
          />
        )
      ) : picking ? (
        <TypePick
          folderName={folders.find((f) => f.id === picking)?.name}
          onPick={(kind) => {
            createProject(kind, picking);
            setPicking(null);
          }}
          onBack={() => setPicking(null)}
        />
      ) : (
        <Home
          folders={folders}
          projects={projects}
          openFolderId={openFolderId}
          onOpenFolder={setOpenFolderId}
          onNewProject={(folderId) => setPicking(folderId)}
          onOpen={(id) => selectProject(id)}
          onDeleteProject={deleteProject}
          onMoveProject={moveProject}
          onRenameProject={requestProjectName}
          onNewFolder={requestNewFolder}
          onRenameFolder={requestFolderName}
          onDeleteFolder={(folder) => {
            deleteFolder(folder.id);
            if (openFolderId === folder.id) setOpenFolderId(null);
          }}
          onInfo={() => setInfo(true)}
        />
      )}
      {info && <InfoSheet onClose={() => setInfo(false)} />}
      {naming && (
        <NameDialog
          title={naming.title}
          label={naming.label}
          initial={naming.initial}
          placeholder={naming.target === 'new-folder' ? 'Например, «Дом на склоне»' : 'Название'}
          confirmLabel={naming.target === 'new-folder' ? 'Создать' : 'Сохранить'}
          onConfirm={confirmName}
          onCancel={() => setNaming(null)}
        />
      )}
    </div>
  );
}
