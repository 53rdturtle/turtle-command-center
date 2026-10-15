import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

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
