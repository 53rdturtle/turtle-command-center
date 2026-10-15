import { Component, useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import { AttachImage, ImageThumbs, useImageInput, withImages } from './images.tsx';
import { ago, elapsed, useNow } from './time.ts';
import { agentDone, api, MODELS, onStream, type Checkpoint, type DiffFile, type MergeFailure, type Option, type Permission, type Subtask, type Task, type TaskDiff, type TaskEvent, type TryEnv } from './api.ts';

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

const MERGE_LABEL: Record<NonNullable<Task['mergeState']>, string> = {
  queued: 'Merge queued',
  merging: 'Merging',
  resolving: 'Resolving conflicts',
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

/** True when the task branch has work the checkout lacks; rechecked on task updates, branch switches and window focus. */
function useMergeable(task: Task, targetBranch: string | null) {
  const eligible = Boolean(task.branch && task.worktree) && !task.mergeState && !['running', 'queued', 'done'].includes(task.status);
  const [mergeable, setMergeable] = useState(false);
  useEffect(() => {
    if (!eligible) return setMergeable(false);
    let alive = true;
    // If the check itself fails, show the button and let a merge attempt report the problem.
    const check = () => api.mergeable(task.id).catch(() => true).then((m) => alive && setMergeable(m));
    check();
    addEventListener('focus', check);
    return () => {
      alive = false;
      removeEventListener('focus', check);
    };
  }, [eligible, task.id, task.updatedAt, targetBranch]);
  return eligible && mergeable;
}

type CardProps = { task: Task; parent?: Task; children: Task[]; targetBranch: string | null; defaultModel: string; tryCommand?: string };

/** How long since the card last changed: how long it has waited on you, or when a running agent last did something. */
function CardAge({ task }: { task: Task }) {
  const now = useNow();
  const waiting = task.permissions.length > 0 || task.status === 'needs_input' || task.status === 'split_proposed';
  const label =
    task.status === 'running' ? `active ${ago(task.updatedAt, now)}`
    : waiting ? `waiting ${elapsed(task.updatedAt, now)}`
    : ago(task.updatedAt, now);
  return <span className="card-age muted" title={new Date(task.updatedAt).toLocaleString()}>{label}</span>;
}

export function TaskCard({ task, parent, children, targetBranch, defaultModel, tryCommand = '' }: CardProps) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tried, setTried] = useState<TryEnv | null>(null);
  const { busy, error, run } = useAction();
  const status = task.permissions.length ? 'permission' : agentDone(task) ? 'review' : task.status;
  const active = task.status === 'running' || task.status === 'queued';
  const canMerge = useMergeable(task, targetBranch);
  const hasWorktree = Boolean(task.branch && task.worktree);
  const diff = useDiff(task, hasWorktree && (showChanges || !['running', 'queued'].includes(task.status)));
  const merge = () => run(() => api.merge(task.id));
  const target = targetBranch ?? 'your branch';
  // Checkpoint options tagged with a board action run the matching card button; null hides an option that can't run now.
  const boardAction = (action: NonNullable<Option['action']>) =>
    action === 'merge' ? (canMerge ? merge : null)
    : action === 'done' ? (task.status !== 'done' ? () => run(() => api.done(task.id)) : null)
    : () => setConfirmDiscard(true);

  const resumeCmd = task.sessionId && task.worktree ? `cd "${task.worktree}" && claude --resume ${task.sessionId}` : null;
  const copyResume = async () => {
    if (!resumeCmd) return;
    await navigator.clipboard.writeText(resumeCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Branch, account and cost are reference info, so they live in the #id tooltip rather than a chip each.
  const info = [
    task.branch && `Branch: ${task.branch}`,
    task.account && `Account: ${task.account}`,
    task.costUsd > 0 && `≈$${task.costUsd.toFixed(2)} equivalent API cost (counts against subscription usage)`,
  ].filter(Boolean).join('\n');
  const hasDiff = Boolean(diff.data && diff.data.files.length > 0);

  // One primary action per card; everything else sits in the "⋯" menu.
  const primary: { label: string; run: () => Promise<unknown>; title?: string; quiet?: boolean } | null =
    active ? { label: 'Stop', run: () => api.stop(task.id), quiet: true }
    : task.mergeState === 'queued' ? { label: 'Remove from merge queue', run: () => api.cancelMerge(task.id), quiet: true }
    : task.mergeState === 'merging' ? null
    : task.status === 'failed' || task.status === 'limited' ? { label: 'Retry now', run: () => api.retry(task.id) }
    : canMerge ? { label: `Merge into ${targetBranch ?? 'current branch'}`, run: merge, title: `Merge ${task.branch} into the branch checked out in your repo`, quiet: !task.checkpoint?.done }
    : task.status !== 'done' ? { label: 'Mark done', run: () => api.done(task.id), title: 'Keep the branch, remove the worktree', quiet: !task.checkpoint?.done }
    : null;
  // Mark done moves to the menu whenever another action takes the primary slot.
  const doneInMenu = !active && task.status !== 'done' && task.mergeState !== 'merging' && primary?.label !== 'Mark done';

  return (
    <article id={`task-${task.id}`} className={`card status-${status}`} tabIndex={-1} onKeyDown={cardKeys}>
      <header className="card-head">
        <div className="card-title">
          <span className="task-id" title={info || undefined}>#{task.id}</span>
          <h3>{task.title}</h3>
        </div>
        <div className="card-status">
          <CardAge task={task} />
          <span className={`pill pill-${status}`}>
          {(status === 'running' || task.mergeState === 'merging') && <span className="spinner" />}
            {task.permissions.length ? 'Permission' : task.mergeState ? MERGE_LABEL[task.mergeState] : status === 'review' ? 'Ready for review' : STATUS_LABEL[task.status]}
          </span>
        </div>
      </header>

      <div className="meta">
        {parent && <span className="chip">↳ from #{parent.id} {parent.title}</span>}
        <span className={task.model === defaultModel ? 'chip chip-faint' : 'chip'} title={task.model === defaultModel ? 'Model (project default)' : "Model (differs from the project's default)"}>{task.model}</span>
        {hasDiff && diff.data && (
          <button className="chip chip-button mono" onClick={() => setShowChanges((s) => !s)} title={`${showChanges ? 'Hide' : 'Show'} changes relative to ${diff.data.target}`}>
            {showChanges ? '▾' : '▸'} <span className="add">+{diff.data.additions}</span> <span className="del">−{diff.data.deletions}</span> · {diff.data.files.length} file{diff.data.files.length === 1 ? '' : 's'}
          </button>
        )}
        <ContextChip task={task} />
      </div>

      <div className="card-body">
        {task.mergeState === 'queued' && (
          <p className="merging-banner">
            {task.mergePosition === 1 ? 'Next' : `#${task.mergePosition}`} in line to merge into {target}. Merges land one at a time.
          </p>
        )}
        {task.mergeState === 'merging' && <p className="merging-banner">Merging into {target}…</p>}
        {task.mergeState === 'resolving' && (
          <p className="merging-banner">
            Merging into {target}: the agent is resolving conflicts with it first. It rejoins the merge queue once it's done.
          </p>
        )}
        {task.permissions.map((p) => <PermissionRequest key={p.id} p={p} />)}
        <Body task={task} children={children} boardAction={boardAction} />
      </div>

      {tried && (
        <p className="muted try-note">
          Opened a terminal in the worktree{tryCommand && <> running <code>{tryCommand}</code></>}. A copy of this board started there
          uses dev port {tried.TCC_DEV_PORT} and API port {tried.TCC_PORT}.{' '}
          <button className="ghost small" onClick={() => setTried(null)}>×</button>
        </p>
      )}
      {task.mergeFailure && <MergeFailureNotice taskId={task.id} failure={task.mergeFailure} />}
      {error && <p className="error">{error}</p>}

      <footer className="card-actions">
        {confirmDiscard ? (
          <>
            <span className="confirm-text muted">Delete this task's work and branch?</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => setConfirmDiscard(false)}>Cancel</button>
            <button className="danger" disabled={busy} onClick={() => run(() => api.discard(task.id))}>Discard work + branch</button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <Menu>
              <MenuItem onClick={() => setShowTranscript((s) => !s)}>{showTranscript ? 'Hide transcript' : 'Transcript'}</MenuItem>
              {/* With a diff, the "+N −M" chip toggles changes; this covers running tasks and empty diffs. */}
              {hasWorktree && !hasDiff && (
                <MenuItem onClick={() => setShowChanges((s) => !s)}>{showChanges ? 'Hide changes' : 'Changes'}</MenuItem>
              )}
              {resumeCmd && (
                <MenuItem disabled={busy} onClick={() => run(() => api.openTerminal(task.id))} title={task.status === 'running' ? 'Stops the agent and continues the session in a new terminal window' : 'Continue the session in a new terminal window'}>
                  Open in terminal
                </MenuItem>
              )}
              {resumeCmd && <MenuItem onClick={copyResume} title={resumeCmd}>{copied ? 'Copied ✓' : 'Copy resume command'}</MenuItem>}
              {task.status === 'limited' && <MenuItem disabled={busy} onClick={() => run(() => api.stop(task.id))}>Stop</MenuItem>}
              {doneInMenu && (
                <MenuItem disabled={busy} onClick={() => run(() => api.done(task.id))} title="Keep the branch, remove the worktree">Mark done</MenuItem>
              )}
              <MenuItem danger onClick={() => setConfirmDiscard(true)}>Discard…</MenuItem>
            </Menu>
            {hasWorktree && !active && (
              <button
                className="ghost"
                disabled={busy}
                onClick={() => run(async () => setTried(await api.tryIt(task.id)))}
                title={tryCommand ? `Run "${tryCommand}" in this task's worktree (change it in project settings)` : "Open a shell in this task's worktree (set a try command in project settings)"}
              >
                Try it
              </button>
            )}
            {primary && (
              <button className={primary.quiet ? 'ghost' : ''} disabled={busy} onClick={() => run(primary.run)} title={primary.title}>
                {primary.label}
              </button>
            )}
          </>
        )}
      </footer>

      {showChanges && <Changes diff={diff} onRefresh={diff.reload} />}
      {showTranscript && <Transcript taskId={task.id} />}
    </article>
  );
}

/** True when keys typed at `el` are text, so board shortcuts must leave them alone. */
export const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** Shortcuts on a focused card: 1-4 pick a checkpoint option, r focuses the reply box, Enter toggles the details. */
function cardKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const card = e.currentTarget;
  if (isTyping(e.target)) {
    // Escape leaves the reply box so j/k work again.
    if (e.key === 'Escape') card.focus();
    return;
  }
  if (/^[1-4]$/.test(e.key)) {
    // Options are plain buttons, so a discard option only opens the usual confirmation.
    card.querySelectorAll<HTMLButtonElement>('[data-hotkeys] > button')[Number(e.key) - 1]?.click();
  } else if (e.key === 'r') {
    const box = card.querySelector<HTMLTextAreaElement>('.reply textarea');
    if (!box) return;
    box.focus();
  } else if (e.key === 'Enter' && e.target === card) {
    // Only on the card itself; Enter on a focused button keeps clicking that button.
    card.querySelector<HTMLButtonElement>('.summary > .link')?.click();
  } else return;
  e.preventDefault();
}

/** A "⋯" button with a small dropdown; closes on outside click, Escape, or picking an item. */
function Menu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('mousedown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="More actions">⋯</button>
      {open && <div className="menu-list" role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

function MenuItem({ danger, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return <button role="menuitem" className={danger ? 'menu-item danger-text' : 'menu-item'} {...props} />;
}

const kTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** How full the session's context is; the window size is only known once a run has finished. */
function ContextChip({ task }: { task: Task }) {
  const { contextTokens: used, contextWindow: size } = task;
  if (!used) return null;
  if (!size) return <span className="chip" title="Tokens in the session's context">Context {kTokens(used)}</span>;
  const pct = Math.round((used / size) * 100);
  return (
    <span className={`chip${pct >= 80 ? ' chip-warn' : ''}`} title={`${kTokens(used)} of ${kTokens(size)} tokens. The CLI compacts the conversation when it gets close to full.`}>
      Context {pct}%
    </span>
  );
}

type BoardActionFn = (action: NonNullable<Option['action']>) => (() => unknown) | null;

function Body({ task, children, boardAction }: { task: Task; children: Task[]; boardAction: BoardActionFn }) {
  switch (task.status) {
    case 'running':
      return <p className="activity">{task.lastActivity ?? 'Starting session…'}</p>;
    case 'queued':
      return <p className="muted">Waiting for a free agent slot.{task.queuedPrompt && <><br /><em>Next message: {truncate(task.queuedPrompt, 160)}</em></>}</p>;
    case 'limited':
      return (
        <p className="muted">
          {task.account ? 'Every account hit its usage limit.' : 'Hit a usage limit.'} Retrying automatically at {task.retryAt ? new Date(task.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'soon'}.
        </p>
      );
    case 'failed':
      return <pre className="error-box">{task.error}</pre>;
    case 'needs_input':
      return task.checkpoint ? <QuickReply task={task} boardAction={boardAction} /> : null;
    case 'split_proposed':
      return task.split ? <SplitReview task={task} /> : null;
    case 'split':
      return (
        <div>
          <p className="muted">{subtaskProgress(task)}:</p>
          <ul className="subtask-status">
            {children.map((c) => <li key={c.id}>#{c.id} {c.title} <span className={`pill pill-${c.status} small`}>{STATUS_LABEL[c.status]}</span></li>)}
          </ul>
          <ReplyBox task={task} placeholder="Message the parent session…" />
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

function QuickReply({ task, boardAction }: { task: Task; boardAction: BoardActionFn }) {
  const cp = task.checkpoint!;
  const { busy, error, run } = useAction();
  // One model choice covers both the option buttons and the typed reply.
  const [model, setModel] = useState(task.model);
  const options = cp.options
    .map((o) => ({ ...o, onClick: o.action ? boardAction(o.action) : () => run(() => api.reply(task.id, o.label, model)) }))
    .filter((o) => o.onClick);
  return (
    <div>
      {cp.done && <p className="done-banner">✓ The agent says this task is done.</p>}
      <Summary checkpoint={cp} />
      {/* On a finished task the options are extra work the agent could do, so none is highlighted. */}
      {options.length > 0 && cp.done && <p className="options-label">Optional follow-ups (nothing more is needed):</p>}
      {options.length > 0 && (
        <div className={cp.done ? 'options follow-ups' : 'options'} data-hotkeys>
          {options.map((o, i) => (
            <button key={i} className={i === 0 && !cp.done ? 'option primary' : 'option'} disabled={busy} onClick={o.onClick!}>
              <span>{i < 4 && <kbd className="hotkey">{i + 1}</kbd>}{o.label}</span>
              {o.detail && <small>{o.detail}</small>}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <ReplyBox task={task} model={model} setModel={setModel} />
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

type ReplyBoxProps = { task: Task; placeholder?: string; model?: string; setModel?: (m: string) => void };

// Starts as one line and grows while focused or holding a draft, so cards waiting on you stay short.
function ReplyBox({ task, placeholder = 'Reply…', ...lifted }: ReplyBoxProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [ownModel, setOwnModel] = useState(task.model);
  const [model, setModel] = lifted.setModel ? [lifted.model!, lifted.setModel] : [ownModel, setOwnModel];
  const { busy, error, run } = useAction();
  const images = useImageInput(setText);
  const send = () => text.trim() && !images.uploading && run(async () => {
    await api.reply(task.id, text, model);
    setText('');
  });
  const expanded = focused || text !== '';
  return (
    // Keeping focus on button presses stops the box collapsing (and the button moving) mid-click.
    <div className={expanded ? 'reply expanded' : 'reply'} onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
      <textarea
        rows={expanded ? 3 : 1}
        value={text}
        placeholder={placeholder}
        aria-label="Reply"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={enterToSubmit(send)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...images.handlers}
      />
      <AttachImage images={images} />
      <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model for the next run"
        title={model === task.model ? 'Model for the next run' : `Switches this task from ${task.model} to ${model} when you send`}>
        {MODELS.map((m) => <option key={m}>{m}</option>)}
      </select>
      <button disabled={busy || images.uploading || !text.trim()} onClick={send}>Send</button>
      {focused && <small className="key-hint">Enter to send, Ctrl+Enter for new line. Paste or attach screenshots.</small>}
      <ImageThumbs text={text} uploading={images.uploading} error={images.error} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SplitReview({ task }: { task: Task }) {
  const proposed = task.split!.subtasks;
  // Recommended subtasks start ticked; with no recommendation, all of them do.
  const anyRecommended = proposed.some((s) => s.recommended);
  const [subtasks, setSubtasks] = useState(() => proposed.map((s) => ({ ...s, picked: !anyRecommended || !!s.recommended })));
  const [open, setOpen] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const update = (i: number, patch: Partial<(typeof subtasks)[number]>) =>
    setSubtasks((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const picked = subtasks.filter((s) => s.picked).map(({ title, prompt }) => ({ title, prompt }));

  return (
    <div>
      <div className="summary md"><Markdown>{task.split!.rationale}</Markdown></div>
      <ul className="subtasks">
        {subtasks.map((s, i) => (
          <li key={i} className={s.picked ? '' : 'unpicked'}>
            <div className="subtask-row">
              <input type="checkbox" checked={s.picked} onChange={(e) => update(i, { picked: e.target.checked })} aria-label={`Create "${s.title}"`} />
              <button className="subtask-head" onClick={() => setOpen((o) => (o === i ? null : i))} aria-expanded={open === i}>
                <strong>{s.title}</strong>
                {s.recommended && <span className="subtask-rec">Recommended</span>}
                {open !== i && <small>{truncate(s.prompt, 140)}</small>}
              </button>
            </div>
            {open === i && (
              <div className="subtask-edit">
                <input value={s.title} onChange={(e) => update(i, { title: e.target.value })} />
                <textarea rows={5} value={s.prompt} onChange={(e) => update(i, { prompt: e.target.value })} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="options">
        <button className="option primary" disabled={busy || picked.length === 0} onClick={() => run(() => api.approveSplit(task.id, picked))}>
          Create {picked.length} subtask{picked.length === 1 ? '' : 's'}
        </button>
        <button className="option" disabled={busy} onClick={() => run(() => api.reply(task.id, "Don't split. Keep this as one task and continue."))}>
          Keep as one task
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function MergeFailureNotice({ taskId, failure }: { taskId: number; failure: MergeFailure }) {
  const { busy, error, run } = useAction();
  // Replying also clears the failure.
  const askAgent = () => run(() => api.reply(taskId,
    `Merging into \`${failure.target}\` conflicts in: ${failure.conflicts.join(', ')}. ` +
    `Run \`git merge ${failure.target}\` in your worktree, resolve the conflicts, run any relevant checks, commit, and report back.`));
  const onDismiss = () => run(() => api.dismissMergeFailure(taskId));
  const dismiss = <button className="option" disabled={busy} onClick={onDismiss}>Dismiss</button>;
  // Failures stored before `reason` existed only tell conflicts apart by their file list.
  const reason = failure.reason ?? (failure.conflicts.length ? 'conflicts' : 'error');
  return (
    <div className="merge-failure">
      {reason === 'conflicts' ? (
        <>
          <p><strong>Merge conflicts with {failure.target}</strong>. Nothing was merged, so your checkout is unchanged.</p>
          <ul>{failure.conflicts.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          <div className="options">
            <button className="option primary" disabled={busy} onClick={askAgent}>Ask the agent to resolve them</button>
            {dismiss}
          </div>
        </>
      ) : reason === 'dirty' ? (
        <>
          <p><strong>Your checkout of {failure.target} has uncommitted changes</strong>, so nothing was merged.
            Commit or stash them (<code>git stash</code>), then merge again.</p>
          <ul>{(failure.files ?? []).map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          <div className="options">{dismiss}</div>
        </>
      ) : reason === 'detached' || reason === 'in_progress' ? (
        <>
          <p><strong>Couldn't merge.</strong> {failure.message} Nothing was changed.</p>
          <div className="options">{dismiss}</div>
        </>
      ) : (
        <>
          <p><strong>Couldn't merge into {failure.target}.</strong> Git reported:</p>
          <pre>{failure.message}</pre>
          <div className="options">{dismiss}</div>
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
          {e.kind === 'tool' ? <code>{e.text}</code> : <div className="md"><Markdown>{withImages(e.text)}</Markdown></div>}
        </div>
      ))}
    </div>
  );
}

type DiffState = { data: TaskDiff | null; error: string | null; loading: boolean; reload: () => void };

/** Loads the task's diff, refreshing whenever the task updates (new commits, checkpoints). */
function useDiff(task: Task, enabled: boolean): DiffState {
  const [data, setData] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    api.diff(task.id)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [task.id, task.updatedAt, enabled, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

function Changes({ diff, onRefresh }: { diff: DiffState; onRefresh: () => void }) {
  const { data, error, loading } = diff;
  return (
    <div className="changes">
      <div className="changes-head">
        {data ? (
          <span className="muted">
            {data.files.length} file{data.files.length === 1 ? '' : 's'} changed vs <code>{data.target}</code>
            {' '}(<span className="add">+{data.additions}</span> <span className="del">−{data.deletions}</span>), including uncommitted work
          </span>
        ) : <span className="muted">{loading ? 'Loading changes…' : ''}</span>}
        <span className="spacer" />
        <button className="ghost small" disabled={loading} onClick={onRefresh}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {data && data.files.length === 0 && <p className="muted">No changes yet.</p>}
      {data?.truncated && <p className="warn-note">The diff is large, so some files' contents are omitted below. Open the worktree to see everything.</p>}
      {data?.files.map((f) => <FileDiff key={f.path} file={f} defaultOpen={data.files.length <= 10 && (f.patch?.length ?? 0) < 40_000} />)}
    </div>
  );
}

const FILE_STATUS: Record<string, string> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type changed' };

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`diff-status st-${file.status}`} title={FILE_STATUS[file.status] ?? file.status}>{file.status}</span>
        <span className="mono diff-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        <span className="mono diff-counts">
          {file.additions === null ? 'binary' : <><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></>}
        </span>
      </button>
      {open && (file.patch === null
        ? <p className="muted diff-omitted">Omitted (diff too large).</p>
        : <DiffLines patch={file.patch} />)}
    </div>
  );
}

function DiffLines({ patch }: { patch: string }) {
  // Skip the git header (diff --git / index / --- / +++); hunks start at the first "@@".
  const lines = patch.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  if (start < 0) return <p className="muted diff-omitted">{/^Binary files/m.test(patch) ? 'Binary file.' : 'No content changes.'}</p>;
  const body = lines.slice(start);
  if (body[body.length - 1] === '') body.pop();
  return (
    <pre className="diff-lines">
      {body.map((l, i) => {
        const cls = l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '\\' ? 'note' : '';
        return <div key={i} className={`dl ${cls}`}>{l || ' '}</div>;
      })}
    </pre>
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
