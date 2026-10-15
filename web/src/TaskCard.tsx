import { Component, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import { agentDone, api, onStream, type Checkpoint, type MergeResult, type Permission, type Subtask, type Task, type TaskEvent } from './api.ts';

const STATUS_LABEL: Record<Task['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  needs_input: 'Needs you',
  split_proposed: 'Split proposed',
  split: 'Split',
  limited: 'Usage limit',
  failed: 'Failed',
  done: 'Done',
  discarded: 'Discarded',
};

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function TaskCard({ task, parent, children, targetBranch }: { task: Task; parent?: Task; children: Task[]; targetBranch: string | null }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [mergeFailure, setMergeFailure] = useState<Extract<MergeResult, { ok: false }> | null>(null);
  const { busy, error, run } = useAction();
  const status = task.permissions.length ? 'permission' : task.status;
  // Finished cards keep only the closing actions in view; the rest sit behind "⋯".
  const finished = agentDone(task) || task.status === 'done';
  const secondary = !finished || showMore;
  const canMerge = Boolean(task.branch && task.worktree) && !['running', 'queued', 'done'].includes(task.status);
  const merge = () => run(async () => {
    setMergeFailure(null);
    const result = await api.merge(task.id);
    if (!result.ok) setMergeFailure(result);
  });

  const resumeCmd = task.sessionId && task.worktree ? `cd "${task.worktree}" && claude --resume ${task.sessionId}` : null;
  const copyResume = async () => {
    if (!resumeCmd) return;
    await navigator.clipboard.writeText(resumeCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <article className={`card status-${status}`}>
      <header className="card-head">
        <div className="card-title">
          <span className="task-id">#{task.id}</span>
          <h3>{task.title}</h3>
        </div>
        <span className={`pill pill-${status}`}>
          {status === 'running' && <span className="spinner" />}
          {task.permissions.length ? 'Permission' : STATUS_LABEL[task.status]}
        </span>
      </header>

      <div className="meta">
        {parent && <span className="chip">↳ from #{parent.id} {parent.title}</span>}
        <span className="chip">{task.model}</span>
        {task.branch && <span className="chip mono">{task.branch}</span>}
        {task.costUsd > 0 && <span className="chip" title="Equivalent API cost; on a subscription this counts against usage limits">≈${task.costUsd.toFixed(2)}</span>}
      </div>

      <div className="card-body">
        {task.permissions.map((p) => <PermissionRequest key={p.id} p={p} />)}
        <Body task={task} children={children} />
      </div>

      {mergeFailure && <MergeFailure taskId={task.id} failure={mergeFailure} onDismiss={() => setMergeFailure(null)} />}
      {error && <p className="error">{error}</p>}

      <footer className="card-actions">
        {secondary && (
          <button className="ghost" onClick={() => setShowTranscript((s) => !s)}>
            {showTranscript ? 'Hide transcript' : 'Transcript'}
          </button>
        )}
        {secondary && resumeCmd && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.openTerminal(task.id))} title={task.status === 'running' ? 'Stops the agent and continues the session in a new terminal window' : 'Continue the session in a new terminal window'}>
            Open in terminal
          </button>
        )}
        {secondary && resumeCmd && (
          <button className="ghost" onClick={copyResume} title={resumeCmd}>
            {copied ? 'Copied ✓' : 'Copy resume cmd'}
          </button>
        )}
        <span className="spacer" />
        {(task.status === 'running' || task.status === 'queued' || task.status === 'limited') && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.stop(task.id))}>Stop</button>
        )}
        {(task.status === 'failed' || task.status === 'limited') && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.retry(task.id))}>Retry now</button>
        )}
        {canMerge && (
          <button className={task.checkpoint?.done ? '' : 'ghost'} disabled={busy} onClick={merge} title={`Merge ${task.branch} into the branch checked out in your repo`}>
            Merge into {targetBranch ?? 'current branch'}
          </button>
        )}
        {task.status !== 'done' && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.done(task.id))} title="Keep the branch, remove the worktree">Mark done</button>
        )}
        {!secondary ? null : confirmDiscard ? (
          <>
            <button className="danger" disabled={busy} onClick={() => run(() => api.discard(task.id))}>Discard work + branch</button>
            <button className="ghost" onClick={() => setConfirmDiscard(false)}>Cancel</button>
          </>
        ) : (
          <button className="ghost" onClick={() => setConfirmDiscard(true)}>Discard</button>
        )}
        {finished && (
          <button className="ghost" onClick={() => setShowMore((m) => !m)} title={showMore ? 'Fewer actions' : 'Transcript, terminal, discard…'}>
            {showMore ? '×' : '⋯'}
          </button>
        )}
      </footer>

      {showTranscript && <Transcript taskId={task.id} />}
    </article>
  );
}

function Body({ task, children }: { task: Task; children: Task[] }) {
  switch (task.status) {
    case 'running':
      return <p className="activity">{task.lastActivity ?? 'Starting session…'}</p>;
    case 'queued':
      return <p className="muted">Waiting for a free agent slot.{task.queuedPrompt && <><br /><em>Next message: {truncate(task.queuedPrompt, 160)}</em></>}</p>;
    case 'limited':
      return (
        <p className="muted">
          Hit a usage limit. Retrying automatically at {task.retryAt ? new Date(task.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'soon'}.
        </p>
      );
    case 'failed':
      return <pre className="error-box">{task.error}</pre>;
    case 'needs_input':
      return task.checkpoint ? <QuickReply task={task} /> : null;
    case 'split_proposed':
      return task.split ? <SplitReview task={task} /> : null;
    case 'split':
      return (
        <div>
          <p className="muted">{subtaskProgress(task)}:</p>
          <ul className="subtask-status">
            {children.map((c) => <li key={c.id}>#{c.id} {c.title} <span className={`pill pill-${c.status} small`}>{STATUS_LABEL[c.status]}</span></li>)}
          </ul>
          <ReplyBox taskId={task.id} placeholder="Message the parent session (e.g. 'Subtasks are done, integrate and verify')…" />
        </div>
      );
    case 'done':
      return task.checkpoint ? <Summary checkpoint={task.checkpoint} /> : null;
  }
}

/** e.g. "2/3 subtasks done"; discarded subtasks don't count toward the total. */
function subtaskProgress(task: Task) {
  const s = task.subtasks;
  if (!s) return 'Split into subtasks';
  const total = s.total - s.discarded;
  return `${s.done}/${total} subtask${total === 1 ? '' : 's'} done` + (s.discarded ? `, ${s.discarded} discarded` : '');
}

/** The TL;DR, with the agent's supporting details one click away. */
function Summary({ checkpoint }: { checkpoint: Checkpoint }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="summary">
      <div className="md"><Markdown>{checkpoint.summary}</Markdown></div>
      {checkpoint.details && (
        <>
          <button className="link" onClick={() => setOpen((o) => !o)}>{open ? 'Less' : 'More'}</button>
          {open && <div className="details md"><Markdown>{checkpoint.details}</Markdown></div>}
        </>
      )}
    </div>
  );
}

function QuickReply({ task }: { task: Task }) {
  const cp = task.checkpoint!;
  const { busy, error, run } = useAction();
  const [followUp, setFollowUp] = useState(false);
  const showReply = !cp.done || followUp;
  return (
    <div>
      {cp.done && <p className="done-banner">✓ The agent says this task is done.</p>}
      <Summary checkpoint={cp} />
      {cp.done && <button className="link" onClick={() => setFollowUp((f) => !f)}>{followUp ? 'Hide follow-up' : 'Follow up…'}</button>}
      {showReply && cp.options.length > 0 && (
        <div className="options">
          {cp.options.map((o, i) => (
            <button key={i} className={i === 0 ? 'option primary' : 'option'} disabled={busy} onClick={() => run(() => api.reply(task.id, o.label))}>
              <span>{o.label}</span>
              {o.detail && <small>{o.detail}</small>}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {showReply && <ReplyBox taskId={task.id} />}
    </div>
  );
}

// Shared textarea key handling: Enter submits, Ctrl/Shift+Enter inserts a newline.
// Enter during IME composition (e.g. picking a Chinese candidate) is left alone.
export function enterToSubmit(submit: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.altKey) return;
    if (e.shiftKey) return; // browser inserts the newline itself
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Enter doesn't insert anything natively; execCommand keeps undo history and fires onChange.
      document.execCommand('insertText', false, '\n');
      return;
    }
    submit();
  };
}

function ReplyBox({ taskId, placeholder = 'Reply in your own words…  (Enter to send, Ctrl+Enter for new line)' }: { taskId: number; placeholder?: string }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const send = () => text.trim() && run(async () => {
    await api.reply(taskId, text);
    setText('');
  });
  return (
    <div className="reply">
      <textarea
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={enterToSubmit(send)}
      />
      <button disabled={busy || !text.trim()} onClick={send}>Send</button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SplitReview({ task }: { task: Task }) {
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.split!.subtasks);
  const { busy, error, run } = useAction();
  const update = (i: number, patch: Partial<Subtask>) =>
    setSubtasks((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div>
      <div className="summary md"><Markdown>{task.split!.rationale}</Markdown></div>
      <ol className="subtasks">
        {subtasks.map((s, i) => (
          <li key={i}>
            <input value={s.title} onChange={(e) => update(i, { title: e.target.value })} />
            <textarea rows={3} value={s.prompt} onChange={(e) => update(i, { prompt: e.target.value })} />
            <button className="ghost small" onClick={() => setSubtasks((l) => l.filter((_, j) => j !== i))}>Remove</button>
          </li>
        ))}
      </ol>
      <div className="options">
        <button className="option primary" disabled={busy || subtasks.length === 0} onClick={() => run(() => api.approveSplit(task.id, subtasks))}>
          Create {subtasks.length} subtask{subtasks.length === 1 ? '' : 's'}
        </button>
        <button className="option" disabled={busy} onClick={() => run(() => api.reply(task.id, "Don't split. Keep this as one task and continue."))}>
          Keep as one task
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function MergeFailure({ taskId, failure, onDismiss }: { taskId: number; failure: Extract<MergeResult, { ok: false }>; onDismiss: () => void }) {
  const { busy, error, run } = useAction();
  const askAgent = () => run(async () => {
    await api.reply(taskId,
      `Merging into \`${failure.target}\` conflicts in: ${failure.conflicts.join(', ')}. ` +
      `Run \`git merge ${failure.target}\` in your worktree, resolve the conflicts, run any relevant checks, commit, and report back.`);
    onDismiss();
  });
  return (
    <div className="merge-failure">
      {failure.conflicts.length > 0 ? (
        <>
          <p><strong>Merge conflicts with {failure.target}</strong>. The merge was aborted, so your checkout is unchanged.</p>
          <ul>{failure.conflicts.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          <div className="options">
            <button className="option primary" disabled={busy} onClick={askAgent}>Ask the agent to resolve them</button>
            <button className="option" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      ) : (
        <>
          <p><strong>Couldn't merge into {failure.target}.</strong></p>
          <pre>{failure.message}</pre>
          <div className="options"><button className="option" onClick={onDismiss}>Dismiss</button></div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PermissionRequest({ p }: { p: Permission }) {
  const { busy, error, run } = useAction();
  const command = typeof p.input.command === 'string' ? p.input.command : null;
  const description = typeof p.input.description === 'string' ? p.input.description : null;
  return (
    <div className="permission">
      <p>Wants to use <strong>{p.toolName}</strong>{description && <> — {description}</>}</p>
      <pre>{command ?? JSON.stringify(p.input, null, 2)}</pre>
      <div className="options">
        <button className="option primary" disabled={busy} onClick={() => run(() => api.permission(p.id, 'allow'))}>Allow</button>
        {p.alwaysKey && (
          <button className="option" disabled={busy} onClick={() => run(() => api.permission(p.id, 'always'))}>Always allow <code>{p.alwaysKey}</code></button>
        )}
        <button className="option" disabled={busy} onClick={() => run(() => api.permission(p.id, 'deny'))}>Deny</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Transcript({ taskId }: { taskId: number }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    api.events(taskId).then((e) => alive && setEvents(e));
    const off = onStream((m) => {
      if (m.type === 'event' && m.event.task_id === taskId) setEvents((list) => [...list, m.event]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [taskId]);
  // Scroll only the transcript box to its end; scrollIntoView would also scroll the page.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className="transcript" ref={box}>
      {events.length === 0 && <p className="muted">No activity yet.</p>}
      {events.map((e) => (
        <div key={e.id} className={`ev ev-${e.kind}`}>
          <span className="ev-kind">{e.kind}</span>
          {e.kind === 'tool' ? <code>{e.text}</code> : <div className="md"><Markdown>{e.text}</Markdown></div>}
        </div>
      ))}
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Keeps a rendering bug in one card from blanking the whole board. */
export class CardErrorBoundary extends Component<{ taskId: number; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <article className="card status-failed">
        <p className="error">Card #{this.props.taskId} failed to render: {this.state.error.message}</p>
        <button className="ghost small" onClick={() => this.setState({ error: null })}>Try again</button>
      </article>
    );
  }
}
