import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentDone, api, MODELS, needsAttention, onStream, PERMISSION_MODES, type Account, type AccountUsage, type BoardVersion, type Project, type UsageWindow, type Task } from './api.ts';
import { CardErrorBoundary, enterToSubmit, TaskCard } from './TaskCard.tsx';
import { ImageThumbs, useImageInput } from './images.tsx';

const slugFromPath = () => decodeURIComponent(location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? '');

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [slug, setSlug] = useState(slugFromPath);
  const [showAddProject, setShowAddProject] = useState(false);
  const [drawer, setDrawer] = useState<'settings' | 'accounts' | null>(null);
  const toggleDrawer = (which: 'settings' | 'accounts') => setDrawer((d) => (d === which ? null : which));
  const closeDrawer = useCallback(() => setDrawer(null), []);

  const reloadProjects = useCallback(() => api.projects().then(setProjects), []);
  useEffect(() => {
    reloadProjects();
    // The checked-out branch (merge target) can change outside the app.
    addEventListener('focus', reloadProjects);
    return () => removeEventListener('focus', reloadProjects);
  }, [reloadProjects]);

  const navigate = (next: string) => {
    history.pushState(null, '', `/p/${next}`);
    setSlug(next);
    setDrawer((d) => (d === 'settings' ? null : d));
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
        <div className="topbar-main">
          <div className="brand">🐢 <span>Turtle Command Center</span></div>
          {projects && projects.length > 0 && (
            <select className="project-picker" value={slug} onChange={(e) => navigate(e.target.value)} aria-label="Project">
              {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
          )}
          <button className="ghost" onClick={() => setShowAddProject(true)}>+ Project</button>
          {project && (
            <button className="ghost toggle" aria-pressed={drawer === 'settings'} onClick={() => toggleDrawer('settings')}>Settings</button>
          )}
          <button className="ghost toggle" aria-pressed={drawer === 'accounts'} onClick={() => toggleDrawer('accounts')}>Accounts</button>
        </div>
        <div className="topbar-status">
          <BoardUpdate />
          <UsagePills />
          <AgentSlots />
          <NotifyToggle />
        </div>
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

      {drawer === 'accounts' && <Accounts onClose={closeDrawer} />}
      {project && drawer === 'settings' && <ProjectSettings project={project} onSaved={reloadProjects} onClose={closeDrawer} />}
      {project && <Board key={project.slug} project={project} />}
    </div>
  );
}

function Board({ project }: { project: Project }) {
  const [tasks, setTasks] = useState<Map<number, Task>>(new Map());
  const [showDone, setShowDone] = useState(() => localStorage.getItem('tcc.showDone') === '1');
  const toggleDone = () => setShowDone((s) => (localStorage.setItem('tcc.showDone', s ? '0' : '1'), !s));

  useEffect(() => {
    api.tasks(project.slug).then((list) => setTasks(new Map(list.map((t) => [t.id, t]))));
    return onStream((m) => {
      if (m.type === 'task' && m.task.projectSlug === project.slug) {
        setTasks((prev) => {
          const next = new Map(prev);
          if (m.task.status === 'discarded') next.delete(m.task.id);
          else next.set(m.task.id, m.task);
          return next;
        });
      }
    });
  }, [project.slug]);

  const all = [...tasks.values()];
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter | null>(null);
  const searching = query.trim() !== '';
  const matched = searching ? all.filter(matches(query)) : all;
  const unfiltered = group(all);
  const { attention, running, waiting, mergeQueue, parked, review, done } = group(matched);
  const workingCount = running.length + waiting.length + mergeQueue.length + parked.length;
  const shown = (f: Filter) => !filter || filter === f;
  const empty = (text: string) => (searching ? 'No matches.' : text);
  const doneForced = done.length > 0 && (searching || filter === 'done');

  useAttentionSignals(unfiltered.attention, unfiltered.review);

  const card = (t: Task) => (
    <CardErrorBoundary key={t.id} taskId={t.id}>
      <TaskCard
        task={t}
        parent={t.parentId ? tasks.get(t.parentId) : undefined}
        children={all.filter((c) => c.parentId === t.id)}
        targetBranch={project.currentBranch}
        defaultModel={project.defaultModel}
        tryCommand={project.tryCommand}
      />
    </CardErrorBoundary>
  );

  const actionColumn = shown('attention') || shown('review');
  const workingColumn = shown('working');
  return (
    <main className="board">
      <NewTask project={project} />
      <FilterBar
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        counts={{ attention: attention.length, working: workingCount, review: review.length, done: done.length }}
      />
      {(actionColumn || workingColumn) && (
        <div className={`columns${actionColumn && workingColumn ? '' : ' single'}`}>
          {actionColumn && (
            <div className="column">
              <h1 className="column-title">Action required <span className="count">{(shown('attention') ? attention.length : 0) + (shown('review') ? review.length : 0)}</span></h1>
              {shown('attention') && <Section title="Needs you" count={attention.length} empty={empty('Nothing waiting on you. 🎉')}>{attention.map(card)}</Section>}
              {shown('review') && (review.length > 0 || filter === 'review') && (
                <Section title="Ready for review" count={review.length} empty={empty('Nothing to review.')}>{review.map(card)}</Section>
              )}
            </div>
          )}
          {workingColumn && (
            <div className="column">
              <h1 className="column-title">Working <span className="count">{workingCount}</span></h1>
              <Section title="Running" count={running.length} empty={empty('No agents running.')}>{running.map(card)}</Section>
              {waiting.length > 0 && <Section title="Waiting" count={waiting.length}>{waiting.map(card)}</Section>}
              {mergeQueue.length > 0 && (
                <Section title={`Merging into ${project.currentBranch ?? 'your branch'}`} count={mergeQueue.length}>{mergeQueue.map(card)}</Section>
              )}
              {parked.length > 0 && <Section title="Split into subtasks" count={parked.length}>{parked.map(card)}</Section>}
            </div>
          )}
        </div>
      )}
      {shown('done') && (done.length > 0 || filter === 'done') && (
        <section className="section">
          {doneForced ? (
            <h2>Done <span className="count">{done.length}</span></h2>
          ) : (
            <button className="section-toggle" onClick={toggleDone} disabled={done.length === 0}>
              {showDone ? '▾' : '▸'} Done <span className="count">{done.length}</span>
            </button>
          )}
          {filter === 'done' && done.length === 0 && <p className="muted">{empty('Nothing done yet.')}</p>}
          {(showDone || doneForced) && <div className="cards">{done.map(card)}</div>}
        </section>
      )}
    </main>
  );
}

type Filter = 'attention' | 'working' | 'review' | 'done';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'attention', label: 'Needs me' },
  { key: 'working', label: 'Working' },
  { key: 'review', label: 'Ready' },
  { key: 'done', label: 'Done' },
];

/** Sorts tasks into the board's sections. */
function group(all: Task[]) {
  const byUpdate = (a: Task, b: Task) => a.updatedAt - b.updatedAt;
  // Merging now, then the queue in order, then tasks whose agent is resolving conflicts before rejoining it.
  const mergeOrder = (t: Task) => t.mergePosition ?? Infinity;
  return {
    attention: all.filter(needsAttention).sort(byUpdate),
    running: all.filter((t) => !needsAttention(t) && !t.mergeState && t.status === 'running').sort(byUpdate),
    waiting: all.filter((t) => !needsAttention(t) && !t.mergeState && ['queued', 'limited'].includes(t.status)).sort(byUpdate),
    mergeQueue: all.filter((t) => !needsAttention(t) && t.mergeState).sort((a, b) => mergeOrder(a) - mergeOrder(b) || byUpdate(a, b)),
    parked: all.filter((t) => !needsAttention(t) && t.status === 'split'),
    review: all.filter(agentDone).sort(byUpdate),
    done: all.filter((t) => t.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

/** Every word of the query must appear in the task's number, title, description or latest checkpoint summary. */
const matches = (query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (t: Task) => {
    const text = `#${t.id} ${t.title} ${t.description} ${t.checkpoint?.summary ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
};

const typingIn = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

function FilterBar({ query, onQuery, filter, onFilter, counts }: {
  query: string;
  onQuery: (q: string) => void;
  filter: Filter | null;
  onFilter: (f: Filter | null) => void;
  counts: Record<Filter, number>;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typingIn(document.activeElement)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="filter-bar">
      <input
        ref={input}
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          if (query) onQuery('');
          else e.currentTarget.blur();
        }}
        placeholder="Search tasks…  ( / )"
        aria-label="Search tasks"
      />
      {FILTERS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          className={`chip${filter === key ? ' chip-on' : ''}`}
          aria-pressed={filter === key}
          onClick={() => onFilter(filter === key ? null : key)}
        >
          {label} <span className="count">{counts[key]}</span>
        </button>
      ))}
    </div>
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
  const [descFocused, setDescFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const images = useImageInput(setDescription);

  const submit = async () => {
    if (!title.trim() || images.uploading) return;
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
        <button type="submit" disabled={busy || images.uploading || !title.trim()}>Start</button>
      </div>
      {expanded && (
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={enterToSubmit(submit)}
          {...images.handlers}
          onFocus={() => setDescFocused(true)}
          onBlur={() => setDescFocused(false)}
          placeholder="Details (optional)…"
          aria-label="Task details"
        />
      )}
      {expanded && descFocused && <small className="key-hint">Enter to start, Ctrl+Enter for new line. Paste screenshots here.</small>}
      {expanded && <ImageThumbs text={description} uploading={images.uploading} error={images.error} />}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const [form, setForm] = useState({ name: '', path: '', defaultModel: 'sonnet', permissionMode: 'acceptEdits' });
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const browse = async () => {
    setPicking(true);
    setError(null);
    try {
      const path = await api.pickFolder();
      if (path) {
        // Default the project name to the folder name.
        setForm((f) => ({ ...f, path, name: f.name || path.split(/[\\/]/).filter(Boolean).pop() || '' }));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPicking(false);
    }
  };
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
      <label>Local repo path
        <div className="path-row">
          <input value={form.path} onChange={set('path')} placeholder="D:\code\my-project" />
          <button type="button" className="ghost" disabled={picking} onClick={browse}>
            {picking ? 'Choose in the dialog…' : 'Browse…'}
          </button>
        </div>
      </label>
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

/**
 * A side panel over the board. Closes on ×, Escape, or a click outside it. Blurs the focused field first so
 * save-on-blur inputs still save.
 */
function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const close = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    onClose();
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <aside className="drawer panel" role="dialog" aria-label={title}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="ghost close" aria-label="Close" title="Close (Esc)" onClick={close}>×</button>
        </div>
        {children}
      </aside>
    </div>
  );
}

function ProjectSettings({ project, onSaved, onClose }: { project: Project; onSaved: () => void; onClose: () => void }) {
  const save = (patch: Partial<Project>) => api.updateProject(project.slug, patch).then(onSaved);
  return (
    <Drawer title={`${project.name} settings`} onClose={onClose}>
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
      <label className="try-command">Try command
        <input
          key={project.tryCommand}
          className="mono"
          defaultValue={project.tryCommand}
          placeholder={project.suggestedTryCommand || 'Empty: “Try it” just opens a shell in the worktree'}
          onBlur={(e) => e.target.value.trim() !== project.tryCommand && save({ tryCommand: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span>
          “Try it” on a task opens a terminal in its worktree and runs this. It gets free ports in <code>TCC_PORT</code> and{' '}
          <code>TCC_DEV_PORT</code> and a sandbox <code>TCC_DATA_DIR</code>, so a copy of this board runs beside the real one with its own empty database.
        </span>
      </label>
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
    </Drawer>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Claude subscriptions to run agents on. When one hits its usage limit, tasks continue on the next. */
function Accounts({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [form, setForm] = useState({ name: '', token: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.accounts().then(setAccounts).catch((e) => setError(e.message));
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  const run = (p: Promise<Account[]>) => {
    setError(null);
    return p.then(setAccounts).catch((e) => setError((e as Error).message));
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    run(api.addAccount(form).then((list) => (setForm({ name: '', token: '' }), list)));
  };

  return (
    <Drawer title="Accounts" onClose={onClose}>
      <p className="muted">
        Agents run on the first account below that has usage left. When it hits its limit, its tasks resume the same
        session on the next one.
      </p>
      {accounts && (
        <ul className="rules">
          {accounts.map((a) => (
            <li key={a.id}>
              <strong>{a.name}</strong>
              <span className="muted">
                {a.usesToken ? 'token' : 'claude CLI login'}
                {a.active && accounts.length > 1 && <> · in use</>}
                {a.running > 0 && <> · {a.running} running</>}
              </span>
              <Usage usage={a.usage} />
              {a.limitedUntil && (
                <>
                  <span className="pill pill-limited">Limited until {clock(a.limitedUntil)}</span>
                  <button className="ghost small" onClick={() => run(api.clearAccountLimit(a.id))}>Use it now</button>
                </>
              )}
              {accounts.length > 1 && (
                <button className="ghost small" onClick={() => run(api.removeAccount(a.id))}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={add}>
        <label>Name<input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Second Pro account" /></label>
        <label>Token
          <input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))} placeholder="sk-ant-oat01-…" />
        </label>
        <button type="submit" disabled={!form.name.trim() || !form.token.trim()}>Add account</button>
      </form>
      <p className="muted">
        To get a token, run <code>claude setup-token</code> in a terminal and sign in with that account. It's stored in
        this machine's command-center database only.
      </p>
      {error && <p className="error">{error}</p>}
    </Drawer>
  );
}

const percent = (w: UsageWindow) => `${Math.round(w.utilization * 100)}%`;
const ago = (ms: number) => {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
};
const resetLabel = (w: UsageWindow) => {
  if (!w.resetsAt) return 'reset since last report';
  const sameDay = new Date(w.resetsAt).toDateString() === new Date().toDateString();
  return `resets ${sameDay ? clock(w.resetsAt) : new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
};
/** Compact time until reset: "2h 14m" within a day, else the weekday and hour. */
const resetShort = (w: UsageWindow) => {
  if (!w.resetsAt) return 'reset';
  const min = Math.max(0, Math.round((w.resetsAt - Date.now()) / 60_000));
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric' });
};

function UsageBar({ label, window: w }: { label: string; window: UsageWindow }) {
  const level = w.utilization >= 0.9 ? 'high' : w.utilization >= 0.7 ? 'mid' : 'low';
  return (
    <span className="usage" title={`${label} window: ${percent(w)} used, ${resetLabel(w)}`}>
      <span className="usage-label">{label}</span>
      <span className="usage-bar"><span className={`usage-fill usage-${level}`} style={{ width: percent(w) }} /></span>
      <span className="usage-pct">{percent(w)}</span>
      <span className="usage-reset">↻ {resetShort(w)}</span>
    </span>
  );
}

/** Usage is only reported while an agent runs on the account, so it can be stale when idle. */
function Usage({ usage }: { usage: AccountUsage | null }) {
  if (!usage) return <span className="muted">usage shows after its first run</span>;
  return (
    <span className="usage-group">
      {usage.fiveHour && <UsageBar label="5h" window={usage.fiveHour} />}
      {usage.sevenDay && <UsageBar label="7d" window={usage.sevenDay} />}
      <span className="muted usage-age">as of {ago(usage.reportedAt)}</span>
    </span>
  );
}

/** One pill per account: how much of its usage is left, and which one new runs start on. */
function UsagePills() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => onStream((m) => m.type === 'status' && setAccounts(m.accounts ?? [])), []);
  if (!accounts.some((a) => a.usage || a.limitedUntil)) return null;
  const several = accounts.length > 1;
  return (
    <span className="usage-pills">
      {accounts.map((a) => <AccountPill key={a.id} account={a} marked={several && a.active} compact={several && !a.active} />)}
    </span>
  );
}

/** Compact pills (accounts not in use) show just the 5-hour percentage; hover for the rest. */
function AccountPill({ account: a, marked, compact }: { account: Account; marked: boolean; compact: boolean }) {
  const usage = a.usage;
  const title = [
    `${a.name}${marked ? ' (in use)' : ''}`,
    a.limitedUntil && `Hit its usage limit; back at ${clock(a.limitedUntil)}`,
    usage?.fiveHour && `5-hour: ${percent(usage.fiveHour)} used, ${resetLabel(usage.fiveHour)}`,
    usage?.sevenDay && `7-day: ${percent(usage.sevenDay)} used, ${resetLabel(usage.sevenDay)}`,
    usage ? `as of ${ago(usage.reportedAt)}` : 'No usage reported yet; it shows after a run on this account',
  ].filter(Boolean).join('\n');
  if (compact) {
    return (
      <span className="slots usage-pill" title={title}>
        <span className="usage-account">{a.name}</span>
        {a.limitedUntil ? (
          <span className="usage usage-limited">back {clock(a.limitedUntil)}</span>
        ) : usage?.fiveHour ? (
          <span className="usage">5h <span className="usage-pct">{percent(usage.fiveHour)}</span></span>
        ) : (
          <span className="usage">—</span>
        )}
      </span>
    );
  }
  return (
    <span className={`slots usage-pill${marked ? ' usage-pill-active' : ''}`} title={title}>
      <span className="usage-account">{a.name}</span>
      {a.limitedUntil ? (
        <span className="usage usage-limited">limited · back {clock(a.limitedUntil)}</span>
      ) : usage?.fiveHour || usage?.sevenDay ? (
        <>
          {usage.fiveHour && <UsageBar label="5h" window={usage.fiveHour} />}
          {usage.sevenDay && <UsageBar label="7d" window={usage.sevenDay} />}
        </>
      ) : (
        <span className="usage">no data yet</span>
      )}
    </span>
  );
}

/** Shows when tasks merged into the main checkout are newer than this board; one click updates and reloads it. */
function BoardUpdate() {
  const [version, setVersion] = useState<BoardVersion | null>(null);
  const [phase, setPhase] = useState<'idle' | 'updating' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const before = useRef<BoardVersion | null>(null);

  useEffect(() => {
    const load = () => api.boardVersion().then(setVersion).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    addEventListener('focus', load);
    return () => (clearInterval(timer), removeEventListener('focus', load));
  }, []);

  // While updating, wait for the restarted server: reload on a new version, report a rollback otherwise.
  useEffect(() => {
    if (phase !== 'updating') return;
    const timer = setInterval(async () => {
      const next = await api.boardVersion().catch(() => null);
      if (!next || !before.current || next.startedAt === before.current.startedAt) {
        if (next) setVersion(next); // still waiting for a merge to finish
        return;
      }
      if (next.current !== before.current.current) location.reload();
      else {
        setVersion(next);
        setError(next.canUpdate ? next.lastError : null);
        setPhase('failed');
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [phase]);

  if (!version?.canUpdate || (version.behind === 0 && phase === 'idle')) return null;
  const busyMerges = version.merges.merging + version.merges.queued;
  const update = () => {
    before.current = version;
    setError(null);
    setPhase('updating');
    api.updateBoard().catch((e) => (setError((e as Error).message), setPhase('failed')));
  };

  const mergeWarning = busyMerges > 0
    ? `${busyMerges} merge${busyMerges === 1 ? ' is' : 's are'} in progress or queued. The update waits for the current one to finish; queued ones continue after the restart.`
    : '';
  return (
    <span className="board-update">
      {phase === 'updating' ? (
        <span className="slots">{version.merges.merging > 0 ? 'Waiting for the merge to finish…' : 'Updating the board…'}</span>
      ) : (
        <button className="ghost" onClick={update} title={mergeWarning || `Update to the latest ${version.behind} commit(s) and reload`}>
          {busyMerges > 0 && '⚠ '}Update board ({version.behind} new)
        </button>
      )}
      {phase !== 'updating' && busyMerges > 0 && <span className="warn-text">merging</span>}
      {phase === 'failed' && <span className="error" title={error ?? ''}>Update failed; still on {version.current}.</span>}
    </span>
  );
}

function AgentSlots() {
  const [status, setStatus] = useState<{ running: number; maxConcurrent: number } | null>(null);
  useEffect(() => onStream((m) => m.type === 'status' && setStatus({ running: m.running, maxConcurrent: m.maxConcurrent })), []);
  if (!status) return null;
  const save = (value: string) => {
    const n = Number(value);
    if (n === status.maxConcurrent) return;
    api.setMaxConcurrent(n).then(setStatus).catch((err) => alert(err.message));
  };
  return (
    <span className="slots" title="Agents running across all projects. Edit the number to change the max; extra tasks queue.">
      {status.running}/
      <input
        key={status.maxConcurrent}
        type="number"
        min={1}
        max={50}
        defaultValue={status.maxConcurrent}
        onBlur={(e) => save(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      agents
    </span>
  );
}

function NotifyToggle() {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  if (perm !== 'default') return null;
  return <button className="ghost" onClick={() => Notification.requestPermission().then(setPerm)}>Enable notifications</button>;
}

/** Tab-title badge for tasks that need you, plus a desktop notification when one newly needs you or an agent finishes. */
function useAttentionSignals(attention: Task[], finished: Task[]) {
  const seen = useRef<Set<string> | null>(null);
  const notify = useMemo(() => [...attention, ...finished], [attention, finished]);
  const keys = useMemo(() => notify.map((t) => `${t.id}:${t.updatedAt}`), [notify]);

  useEffect(() => {
    document.title = attention.length ? `(${attention.length}) Turtle Command Center` : 'Turtle Command Center';
    const current = new Set(notify.map((t) => String(t.id)));
    if (seen.current && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      for (const t of notify) {
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
  }, [keys.join(), attention.length]);
}
