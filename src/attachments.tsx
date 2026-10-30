import { useEffect, useRef, useState } from "react";
import { Download, Paperclip, X } from "lucide-react";
import { api } from "./api.js";
import type { Attachment } from "./model.js";

const attachmentsUrl = (boardId: string, cardId: string) =>
  `/api/boards/${boardId}/cards/${cardId}/attachments`;

/** Streams the file as the raw request body, so a large file never goes through JSON or memory. */
export async function uploadAttachment(
  boardId: string,
  cardId: string,
  file: File,
): Promise<Attachment> {
  const response = await fetch(
    `${attachmentsUrl(boardId, cardId)}?name=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? `Upload failed (${response.status})`);
  return data as Attachment;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const isImage = (item: Attachment) =>
  /^image\/(png|jpeg|gif|webp)$/.test(item.type);

/** Thumbnails for images and download links for everything else. */
export function AttachmentGrid({
  boardId,
  items,
  onRemove,
}: {
  boardId: string;
  items: Attachment[];
  onRemove?: (item: Attachment) => void;
}) {
  if (!items.length) return null;
  return (
    <ul aria-label="Attachments" className="mt-2 flex flex-wrap gap-2">
      {items.map((item) => {
        const href = `${attachmentsUrl(boardId, item.cardId)}/${item.id}`;
        return (
          <li
            key={item.id}
            className="relative rounded-md border border-border bg-background/60 text-xs"
          >
            {isImage(item) ? (
              <a href={href} target="_blank" rel="noreferrer" title={item.name}>
                <img
                  src={href}
                  alt={item.name}
                  loading="lazy"
                  className="h-24 max-w-48 rounded-md object-cover"
                />
              </a>
            ) : (
              <a
                href={href}
                download={item.name}
                className="flex items-center gap-1.5 px-2 py-1.5 hover:underline"
              >
                <Download size={13} />
                <span className="max-w-48 truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {formatSize(item.size)}
                </span>
              </a>
            )}
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => onRemove(item)}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5"
              >
                <X size={11} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A "Attach files" button that hands the chosen files back. */
export function FilePicker({
  onPick,
  disabled,
}: {
  onPick: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={(event) => {
          onPick([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/20 disabled:opacity-50"
      >
        <Paperclip size={13} /> Attach files
      </button>
    </>
  );
}

/** The card's own files (those not sent with a discussion message), with upload and remove. */
export function CardAttachments({
  boardId,
  cardId,
  count,
  onError,
}: {
  boardId: string;
  cardId: string;
  /** The card's attachment count; the list is fetched only when there are files to list. */
  count: number;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const url = `/boards/${boardId}/cards/${cardId}/attachments`;
  useEffect(() => {
    let current = true;
    if (!count) return;
    api<Attachment[]>(url)
      .then((next) => current && setItems(next))
      .catch((err) => current && onError(String(err)));
    return () => {
      current = false;
    };
  }, [url, count]);
  const upload = async (files: File[]) => {
    setUploading(true);
    try {
      for (const file of files) {
        const saved = await uploadAttachment(boardId, cardId, file);
        setItems((previous) => [...previous, saved]);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };
  return (
    <section aria-label="Card attachments" className="mt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Attachments</h3>
        <FilePicker
          onPick={(files) => void upload(files)}
          disabled={uploading}
        />
      </div>
      {uploading && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Uploading…
        </p>
      )}
      {items.length === 0 && !uploading && (
        <p className="mt-1 text-xs text-muted-foreground">No attachments.</p>
      )}
      <AttachmentGrid
        boardId={boardId}
        items={items.filter((item) => !item.messageId)}
        onRemove={(item) =>
          void api(`${url}/${item.id}`, { method: "DELETE" })
            .then(() =>
              setItems((previous) =>
                previous.filter((it) => it.id !== item.id),
              ),
            )
            .catch((err) => onError(String(err)))
        }
      />
      {items.some((item) => item.messageId) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Sent in discussion ({items.filter((item) => item.messageId).length})
          </summary>
          <AttachmentGrid
            boardId={boardId}
            items={items.filter((item) => item.messageId)}
          />
        </details>
      )}
    </section>
  );
}
