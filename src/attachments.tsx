import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  Paperclip,
  X,
} from "lucide-react";
import { api } from "./api.js";
import { confirmAction } from "./confirm.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.js";
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

/** Asks before an attachment is deleted; resolves true only when the user picks Delete. */
export function confirmDeleteAttachment(item: Attachment): Promise<boolean> {
  return confirmAction(
    `"${item.name}" will be permanently deleted. This cannot be undone.`,
    { title: "Delete attachment?", confirmLabel: "Delete", destructive: true },
  );
}

const isImage = (item: Attachment) =>
  /^image\/(png|jpeg|gif|webp)$/.test(item.type);

const attachmentHref = (boardId: string, item: Attachment) =>
  `${attachmentsUrl(boardId, item.cardId)}/${item.id}`;

/**
 * A popup carousel over a set of images. Arrow keys or the side buttons step through them;
 * "Full size" shows the image at its natural size (scrolling if larger than the window),
 * and "Open original" opens the file in a new tab.
 */
export function AttachmentLightbox({
  boardId,
  images,
  index,
  onIndexChange,
  onClose,
}: {
  boardId: string;
  images: Attachment[];
  /** The image shown, or null when the lightbox is closed. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const [fullSize, setFullSize] = useState(false);
  const item = index === null ? undefined : images[index];
  const count = images.length;
  // Each image opens fitted to the window.
  useEffect(() => setFullSize(false), [item?.id]);
  const step = (delta: number) => {
    if (index === null || count < 2) return;
    onIndexChange((index + delta + count) % count);
  };
  const href = item ? attachmentHref(boardId, item) : "";
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            step(-1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            step(1);
          }
        }}
        overlayClassName="bg-black/85"
        className="flex h-[92vh] w-[min(96vw,1400px)] flex-col gap-3 overflow-hidden p-4"
      >
        {item && (
          <>
            <div className="flex items-center gap-3 pr-8">
              <DialogTitle className="min-w-0 truncate text-sm font-semibold">
                {item.name}
              </DialogTitle>
              <DialogDescription className="shrink-0 text-xs text-muted-foreground">
                {count > 1 && `${(index ?? 0) + 1} of ${count} · `}
                {formatSize(item.size)}
              </DialogDescription>
              <div className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
                <button
                  type="button"
                  aria-pressed={fullSize}
                  onClick={() => setFullSize((value) => !value)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent/20"
                >
                  {fullSize ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  {fullSize ? "Fit to window" : "Full size"}
                </button>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent/20"
                >
                  <ExternalLink size={13} /> Open original
                </a>
                <a
                  href={href}
                  download={item.name}
                  aria-label={`Download ${item.name}`}
                  title="Download"
                  className="inline-flex items-center rounded-md border border-border p-1.5 hover:bg-accent/20"
                >
                  <Download size={13} />
                </a>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              <div
                data-lightbox-stage
                className={
                  fullSize
                    ? "h-full overflow-auto"
                    : "flex h-full items-center justify-center"
                }
              >
                <img
                  key={item.id}
                  src={href}
                  alt={item.name}
                  className={
                    fullSize
                      ? "max-w-none"
                      : "max-h-full max-w-full object-contain"
                  }
                />
              </div>
              {count > 1 && (
                <>
                  <button
                    type="button"
                    aria-label="Previous image"
                    onClick={() => step(-1)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-2 shadow hover:bg-background"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <button
                    type="button"
                    aria-label="Next image"
                    onClick={() => step(1)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-2 shadow hover:bg-background"
                  >
                    <ChevronRight size={20} />
                  </button>
                </>
              )}
            </div>
            {count > 1 && (
              <ol
                aria-label="All images"
                className="flex shrink-0 justify-center gap-2 overflow-x-auto"
              >
                {images.map((image, position) => (
                  <li key={image.id}>
                    <button
                      type="button"
                      aria-label={`Show ${image.name}`}
                      aria-current={position === index}
                      onClick={() => onIndexChange(position)}
                      className={`block rounded border-2 ${position === index ? "border-primary" : "border-transparent opacity-60 hover:opacity-100"}`}
                    >
                      <img
                        src={attachmentHref(boardId, image)}
                        alt=""
                        className="h-12 w-16 rounded-sm object-cover"
                      />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Thumbnails for images and download links for everything else. Clicking a thumbnail opens the images in a lightbox. */
export function AttachmentGrid({
  boardId,
  items,
  onRemove,
}: {
  boardId: string;
  items: Attachment[];
  /** Called after the user confirms deleting the item. */
  onRemove?: (item: Attachment) => void;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const images = items.filter(isImage);
  // A deleted image must not leave the lightbox pointing past the end.
  const shown = viewing !== null && viewing < images.length ? viewing : null;
  if (!items.length) return null;
  return (
    <>
      <ul aria-label="Attachments" className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => {
          const href = attachmentHref(boardId, item);
          return (
            <li
              key={item.id}
              className="relative rounded-md border border-border bg-background/60 text-xs"
            >
              {isImage(item) ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title={item.name}
                  onClick={(event) => {
                    // Modified clicks still open the file in a new tab or window.
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    setViewing(images.indexOf(item));
                  }}
                >
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
                  aria-label={`Delete ${item.name}`}
                  title={`Delete ${item.name}`}
                  onClick={async () => {
                    if (await confirmDeleteAttachment(item)) onRemove(item);
                  }}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5"
                >
                  <X size={11} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <AttachmentLightbox
        boardId={boardId}
        images={images}
        index={shown}
        onIndexChange={setViewing}
        onClose={() => setViewing(null)}
      />
    </>
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
