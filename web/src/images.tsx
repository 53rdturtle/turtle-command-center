import { useState, type ClipboardEvent, type DragEvent } from 'react';
import { api } from './api.ts';

// Pasted images are saved by the server and referenced in the message text as `[Image: <path>]`,
// which the agent opens with its Read tool. The board shows them by name via /api/images.
const TOKEN = /\[Image: [^\]\n]*?\/images\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))\]/g;

const imageUrl = (name: string) => `/api/images/${name}`;

/** Message text with image references turned into Markdown images, for display. */
export const withImages = (text: string) => text.replace(TOKEN, (_, name) => `![screenshot](${imageUrl(name)})`);

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Paste and drop handlers for a textarea: images are uploaded and their reference inserted at the cursor. */
export function useImageInput(setText: (update: (text: string) => string) => void) {
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: File[], el: HTMLTextAreaElement) => {
    setError(null);
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const { path } = await api.uploadImage(await readAsDataUrl(file));
        const token = `[Image: ${path}] `;
        if (document.activeElement === el) {
          // Keeps undo history and fires onChange, like enterToSubmit's newline.
          document.execCommand('insertText', false, token);
        } else {
          setText((t) => (t && !/\s$/.test(t) ? `${t} ` : t) + token);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const images = (list: DataTransferItemList | FileList) =>
    (list instanceof FileList ? Array.from(list) : Array.from(list, (x) => (x.kind === 'file' ? x.getAsFile() : null)))
      .filter((f): f is File => Boolean(f?.type.startsWith('image/')));

  return {
    uploading: uploading > 0,
    error,
    handlers: {
      onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = images(e.clipboardData.items);
        if (!files.length) return;
        e.preventDefault();
        add(files, e.currentTarget);
      },
      onDragOver: (e: DragEvent<HTMLTextAreaElement>) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      },
      onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
        const files = images(e.dataTransfer.files);
        if (!files.length) return;
        e.preventDefault();
        e.currentTarget.focus();
        add(files, e.currentTarget);
      },
    },
  };
}

/** Thumbnails of the images a draft references, plus upload state. */
export function ImageThumbs({ text, uploading, error }: { text: string; uploading: boolean; error: string | null }) {
  const names = [...text.matchAll(TOKEN)].map((m) => m[1]);
  if (!names.length && !uploading && !error) return null;
  return (
    <div className="thumbs">
      {names.map((name, i) => (
        <a key={`${name}-${i}`} href={imageUrl(name)} target="_blank" rel="noreferrer">
          <img src={imageUrl(name)} alt="Pasted screenshot" />
        </a>
      ))}
      {uploading && <span className="muted">Uploading image…</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
