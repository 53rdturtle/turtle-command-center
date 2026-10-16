import { useEffect, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { api, fileRawUrl, type TaskFile } from './api.ts';

// Agents mention files they wrote (`docs/plan.md`, `src/app.ts:42`). In a task's Markdown those
// become links that open the file right on the board, read from the task's worktree.

const KNOWN_EXT = new Set(`md mdx txt log csv tsv json jsonc yml yaml toml ini cfg conf env xml html htm css scss less
  ts tsx js jsx mjs cjs py rb rs go java kt cs c h cc cpp hpp swift lua gd gdshader tscn tres sh bash ps1 bat cmd sql
  png jpg jpeg gif webp svg bmp ico lock prisma graphql vue svelte`.split(/\s+/));
const PATH = /^(?:[A-Za-z]:)?[\w.@~+\-/\\]*?[\w\-]\.([A-Za-z][A-Za-z0-9]{0,9})(?::\d+(?:[-:]\d+)?)?$/;

/** Whether inline code or a link target reads as a file path: a folder plus an extension, or a known extension. */
export function looksLikePath(text: string) {
  if (text.length > 260 || /^[a-z]+:\/\//i.test(text) || text.includes(' ')) return false;
  const m = PATH.exec(text);
  if (!m) return false;
  return /[\\/]/.test(text) || KNOWN_EXT.has(m[1].toLowerCase());
}

const dirOf = (path: string) => path.replace(/[^/]*$/, '');
/** `href` from a Markdown file, relative to that file's folder. */
function joinPath(dir: string, href: string) {
  const parts = (href.startsWith('/') ? href.slice(1) : dir + href).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/** Markdown components turning file paths into viewer links; `base` resolves links inside a viewed file. */
function fileComponents(taskId: number, open: (path: string) => void, base?: string): Components {
  const resolvePath = (p: string) => (base === undefined ? p : joinPath(base, decodeURIComponent(p)));
  return {
    code({ className, children, node: _node, ...rest }) {
      const text = String(children);
      if (className || text.includes('\n') || !looksLikePath(text)) return <code className={className} {...rest}>{children}</code>;
      return (
        <button className="file-link" title="View this file" onClick={() => open(resolvePath(text))}>
          <code>{children}</code>
        </button>
      );
    },
    a({ href, children, node: _node, ...rest }) {
      const target = href?.split('#')[0] ?? '';
      if (target && !/^[a-z]+:/i.test(target) && looksLikePath(decodeURIComponent(target))) {
        return <a href="#" {...rest} onClick={(e) => (e.preventDefault(), open(resolvePath(target)))}>{children}</a>;
      }
      return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
    },
    ...(base !== undefined && {
      img({ src, alt, node: _node, ...rest }) {
        const local = src && !/^[a-z]+:/i.test(src);
        return <img src={local ? fileRawUrl(taskId, joinPath(base, decodeURIComponent(src))) : src} alt={alt} {...rest} />;
      },
    }),
  };
}

/** A task's Markdown (checkpoint, transcript), with file paths opening in the viewer. */
export function TaskMarkdown({ taskId, children }: { taskId: number; children: string }) {
  const [path, setPath] = useState<string | null>(null);
  return (
    <>
      <Markdown components={fileComponents(taskId, setPath)}>{children}</Markdown>
      {path && <FileViewer taskId={taskId} path={path} onClose={() => setPath(null)} />}
    </>
  );
}

function FileViewer({ taskId, path: initial, onClose }: { taskId: number; path: string; onClose: () => void }) {
  // Links inside a viewed Markdown file navigate within the viewer.
  const [history, setHistory] = useState([initial]);
  const path = history[history.length - 1];
  const [file, setFile] = useState<TaskFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    api.file(taskId, path).then((f) => alive && setFile(f), (e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [taskId, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const isMarkdown = file?.kind === 'text' && /\.(md|mdx|markdown)$/i.test(file.path);
  let body: ReactNode = <p className="muted">Loading…</p>;
  if (error) body = <p className="error">{error}</p>;
  else if (file?.kind === 'image') body = <img className="file-image" src={fileRawUrl(taskId, file.path)} alt={file.path} />;
  else if (file?.kind === 'binary') body = <p className="muted">This is a binary file ({formatSize(file.size)}), so it can't be shown here.</p>;
  else if (file?.kind === 'text') {
    body = (
      <>
        {file.truncated && <p className="warn-note">Only the first 1 MB of this {formatSize(file.size)} file is shown.</p>}
        {isMarkdown && !raw
          ? <div className="md"><Markdown components={fileComponents(taskId, (p) => setHistory((h) => [...h, p]), dirOf(file.path))}>{file.text}</Markdown></div>
          : <pre className="file-text">{file.text}</pre>}
      </>
    );
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel file-viewer" role="dialog" aria-label={path} onClick={(e) => e.stopPropagation()}>
        <div className="file-viewer-head">
          {history.length > 1 && <button className="link" onClick={() => setHistory((h) => h.slice(0, -1))}>← Back</button>}
          <span className="mono file-viewer-path" title={path}>{file?.path ?? path}</span>
          {isMarkdown && <button className="link" onClick={() => setRaw((r) => !r)}>{raw ? 'Rendered' : 'Source'}</button>}
          <button className="link" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="file-viewer-body">{body}</div>
      </div>
    </div>
  );
}

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
