import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, MODELS, needsAttention, onStream, PERMISSION_MODES, type Project, type Task } from './api.ts';
import { TaskCard } from './TaskCard.tsx';

const slugFromPath = () => decodeURIComponent(location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? '');

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [slug, setSlug] = useState(slugFromPath);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const reloadProjects = useCallback(() => api.projects().then(setProjects), []);
  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  const navigate = (next: string) => {
    history.pushState(null, '', `/p/${next}`);
    setSlug(next);
    setShowSettings(false);
  };
  useEffect(() => {
    const onPop = () => setSlug(slugFromPath());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  // Land on the first project when the URL doesn't name one.
  useEffect(() => {
    if (projects?.length && !projects.some((p) => p.slug === slug)) {
      history.replaceState(null, '', `/p/${projects[0].slug}`);
      setSlug(projects[0].slug);
    }
  }, [projects, slug]);

  const project = projects?.find((p) => p.slug === slug);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🐢 <span>Turtle Command Center</span></div>
        {projects && projects.length > 0 && (
          <select className="project-picker" value={slug} onChange={(e) => navigate(e.target.value)} aria-label="Project">
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
        )}
        <button className="ghost" onClick={() => setShowAddProject(true)}>+ Project</button>
        {project && <button className="ghost" onClick={() => setShowSettings((s) => !s)}>Settings</button>}
        <span className="spacer" />
        <AgentSlots />
        <NotifyToggle />
      </header>

      {showAddProject && (
        <AddProject
          onClose={() => setShowAddProject(false)}
          onAdded={(p) => {
            setShowAddProject(false);
            reloadProjects().then(() => navigate(p.slug));
          }}
        />
      )}

      {projects && projects.length === 0 && !showAddProject && (
        <div className="empty">
          <h2>Add your first project</h2>
          <p>Point the command center at a local repo. Each task gets its own git worktree and Claude Code session.</p>
          <button onClick={() => setShowAddProject(true)}>+ Add project</button>
        </div>
      )}

      {project && showSettings && <ProjectSettings project={project} onSaved={reloadProjects} />}
      {project && <Board key={project.slug} project={project} />}
    </div>
  );
}

function Board({ project }: { project: Project }) {
  const [tasks, setTasks] = useState<Map<number, Task>>(new Map());
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    api.tasks(project.slug).then((list) => setTasks(new Map(list.map((t) => [t.id, t]))));
    return onStream((m) => {
      if (m.type === 'task' && m.task.projectSlug === project.slug) {
        setTasks((prev) => new Map(prev).set(m.task.id, m.task));
      } else if (m.type === 'removed') {
        setTasks((prev) => {
          const next = new Map(prev);
          next.delete(m.id);
          return next;
        });
      }
    });
  }, [project.slug]);

  const all = [...tasks.values()];
  const byUpdate = (a: Task, b: Task) => a.updatedAt - b.updatedAt;
  const attention = all.filter(needsAttention).sort(byUpdate);
  const working = all.filter((t) => !needsAttention(t) && ['running', 'queued', 'limited'].includes(t.status)).sort(byUpdate);
  const parked = all.filter((t) => !needsAttention(t) && t.status === 'split');
  const done = all.filter((t) => t.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt);

  useAttentionSignals(attention);

  const card = (t: Task) => (
    <TaskCard
      key={t.id}
      task={t}
      parent={t.parentId ? tasks.get(t.parentId) : undefined}
      children={all.filter((c) => c.parentId === t.id)}
    />
  );

  return (
    <main className="board">
      <NewTask project={project} />
      <Section title="Needs you" count={attention.length} empty="Nothing waiting on you. 🎉">{attention.map(card)}</Section>
      <Section title="Working" count={working.length} empty="No agents running.">{working.map(card)}</Section>
      {parked.length > 0 && <Section title="Split into subtasks" count={parked.length}>{parked.map(card)}</Section>}
      {done.length > 0 && (
        <section className="section">
          <button className="section-toggle" onClick={() => setShowDone((s) => !s)}>
            {showDone ? '▾' : '▸'} Done <span className="count">{done.length}</span>
          </button>
          {showDone && <div className="cards">{done.map(card)}</div>}
        </section>
      )}
    </main>
  );
}

function Section({ title, count, empty, children }: { title: string; count: number; empty?: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2>{title} <span className="count">{count}</span></h2>
      {count === 0 ? <p className="muted">{empty}</p> : <div className="cards">{children}</div>}
    </section>
  );
}

function NewTask({ project }: { project: Project }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState(project.defaultModel);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTask(project.slug, { title, description, model });
      setTitle('');
      setDescription('');
      setExpanded(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-task" onSubmit={(e) => (e.preventDefault(), submit())}>
      <div className="new-task-row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setExpanded(true)}
          placeholder={`New task for ${project.name}…`}
          aria-label="Task title"
        />
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          {MODELS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <button type="submit" disabled={busy || !title.trim()}>Start</button>
      </div>
      {expanded && (
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
          placeholder="Details, context, links… (optional, Ctrl+Enter to start)"
        />
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const [form, setForm] = useState({ name: '', path: '', defaultModel: 'sonnet', permissionMode: 'acceptEdits' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onAdded(await api.addProject(form));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Add project</h2>
      <label>Name<input value={form.name} onChange={set('name')} placeholder="My side project" autoFocus /></label>
      <label>Local repo path<input value={form.path} onChange={set('path')} placeholder="D:\code\my-project" /></label>
      <div className="row">
        <label>Default model<select value={form.defaultModel} onChange={set('defaultModel')}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label>Permission mode<select value={form.permissionMode} onChange={set('permissionMode')}>{PERMISSION_MODES.map((m) => <option key={m}>{m}</option>)}</select></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        <button type="submit">Add project</button>
      </div>
    </form>
  );
}

function ProjectSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const save = (patch: Partial<Project>) => api.updateProject(project.slug, patch).then(onSaved);
  return (
    <section className="panel">
      <h2>{project.name} settings</h2>
      <p className="muted mono">{project.path}{project.remote && <> · {project.remote}</>}</p>
      <div className="row">
        <label>Default model
          <select value={project.defaultModel} onChange={(e) => save({ defaultModel: e.target.value })}>
            {MODELS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label>Permission mode
          <select value={project.permissionMode} onChange={(e) => save({ permissionMode: e.target.value })}>
            {PERMISSION_MODES.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
      </div>
      <h3>Always allowed</h3>
      {project.alwaysAllow.length === 0 ? (
        <p className="muted">Nothing yet. Use “Always allow” on a permission request to add rules.</p>
      ) : (
        <ul className="rules">
          {project.alwaysAllow.map((rule) => (
            <li key={rule}>
              <code>{rule}</code>
              <button className="ghost small" onClick={() => save({ alwaysAllow: project.alwaysAllow.filter((r) => r !== rule) })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentSlots() {
  const [status, setStatus] = useState<{ running: number; maxConcurrent: number } | null>(null);
  useEffect(() => onStream((m) => m.type === 'status' && setStatus({ running: m.running, maxConcurrent: m.maxConcurrent })), []);
  if (!status) return null;
  return <span className="slots" title="Agents running across all projects">{status.running}/{status.maxConcurrent} agents</span>;
}

function NotifyToggle() {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  if (perm !== 'default') return null;
  return <button className="ghost" onClick={() => Notification.requestPermission().then(setPerm)}>Enable notifications</button>;
}

/** Tab-title badge plus a desktop notification whenever a task newly needs you. */
function useAttentionSignals(attention: Task[]) {
  const seen = useRef<Set<string> | null>(null);
  const keys = useMemo(() => attention.map((t) => `${t.id}:${t.updatedAt}`), [attention]);

  useEffect(() => {
    document.title = attention.length ? `(${attention.length}) Turtle Command Center` : 'Turtle Command Center';
    const current = new Set(attention.map((t) => String(t.id)));
    if (seen.current && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      for (const t of attention) {
        if (!seen.current.has(String(t.id))) {
          new Notification(`#${t.id} ${t.title}`, {
            body: t.permissions.length ? `Wants to use ${t.permissions[0].toolName}` : t.checkpoint?.summary.slice(0, 140) ?? 'Needs your input',
            tag: `tcc-${t.id}`,
          });
        }
      }
    }
    seen.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join()]);
}
