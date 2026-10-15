import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { db } from './db.ts';

// Images pasted into the board. Messages reference them as `[Image: <path>]`; agents get this
// folder via --add-dir so they can view them with Read without a permission prompt.
export const IMAGES_DIR = join(DATA_DIR, 'images');

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

/** Saves a `data:image/...;base64,` URL and returns the path to put in a message. */
export function saveImage(dataUrl: string) {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl ?? '');
  const ext = m && TYPES[m[1].toLowerCase()];
  if (!ext) throw new Error('Only PNG, JPEG, GIF and WebP images are supported');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new Error('Image is larger than 10 MB');
  mkdirSync(IMAGES_DIR, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  writeFileSync(join(IMAGES_DIR, name), bytes);
  // Forward slashes: Read accepts them on Windows, and they survive Markdown (backslashes are escapes there).
  return { path: join(IMAGES_DIR, name).replaceAll('\\', '/'), name };
}

export function readImage(name: string) {
  if (!NAME.test(name)) return null;
  const file = join(IMAGES_DIR, name);
  if (!existsSync(file)) return null;
  const ext = name.split('.').pop()!;
  const type = Object.keys(TYPES).find((t) => TYPES[t] === ext)!;
  return { bytes: readFileSync(file), type };
}

// ---------- cleanup ----------
// An image is still needed while any open task mentions it: in its request, a prompt, or its transcript
// (subtask prompts can repeat the parent's images). Once only finished tasks do, it's deleted.

const REF = /\/images\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))/g;
// Pasted into a draft that was never sent; give it a day before treating it as abandoned.
const DRAFT_GRACE_MS = 24 * 60 * 60 * 1000;
const OPEN = "status NOT IN ('done', 'discarded')";

function refs(texts: (string | null)[]) {
  const names = new Set<string>();
  for (const t of texts) for (const m of t?.matchAll(REF) ?? []) names.add(m[1]);
  return names;
}

function taskTexts(where: string, ...params: number[]) {
  const like = "LIKE '%/images/%'";
  const fields = db.prepare(`SELECT description || char(10) || coalesce(pending_prompt, '') || char(10) || coalesce(run_prompt, '')
      || char(10) || coalesce(checkpoint, '') || char(10) || coalesce(split, '') AS text FROM tasks WHERE ${where}`)
    .all(...params) as { text: string }[];
  const events = db.prepare(`SELECT text FROM events WHERE text ${like} AND task_id IN (SELECT id FROM tasks WHERE ${where})`)
    .all(...params) as { text: string }[];
  return [...fields, ...events].map((r) => r.text);
}

function remove(names: Iterable<string>) {
  for (const name of names) rmSync(join(IMAGES_DIR, name), { force: true });
}

/** Deletes the images a just-finished task used, unless an open task still mentions them. */
export function cleanupTaskImages(taskId: number) {
  const inUse = refs(taskTexts(OPEN));
  remove([...refs(taskTexts('id = ?', taskId))].filter((n) => !inUse.has(n)));
}

/** Deletes every image no open task mentions, except recent ones that may belong to an unsent draft. */
export function sweepImages() {
  if (!existsSync(IMAGES_DIR)) return;
  const inUse = refs(taskTexts(OPEN));
  const cutoff = Date.now() - DRAFT_GRACE_MS;
  remove(readdirSync(IMAGES_DIR).filter((n) => NAME.test(n) && !inUse.has(n) && statSync(join(IMAGES_DIR, n)).mtimeMs < cutoff));
}
