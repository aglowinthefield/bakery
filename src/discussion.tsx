import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Button } from "./components/ui/button";
import { Markdown } from "./markdown-view.js";
import type { DiscussionMessage } from "./model.js";

type Discussion = { messages: DiscussionMessage[]; pending: boolean };

/** A chat with the agent about one card. The agent answers from the card, its latest report and the chat so far. */
export function DiscussionPanel({
  boardId,
  cardId,
  onError,
}: {
  boardId: string;
  cardId: string;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<Discussion>({
    messages: [],
    pending: false,
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const url = `/boards/${boardId}/cards/${cardId}/discussion`;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Discussion>(url);
        if (current) setData(next);
      } catch (err) {
        if (current) onError(String(err));
      } finally {
        if (current) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [url]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [data.messages.length, data.pending]);
  const send = async () => {
    const message = draft.trim();
    if (!message || sending || data.pending) return;
    setSending(true);
    try {
      const saved = await api<DiscussionMessage>(url, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      setDraft("");
      setData((previous) => ({
        messages: [...previous.messages, saved],
        pending: true,
      }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  return (
    <section aria-label="Discussion" className="mt-4">
      <p className="text-xs text-muted-foreground">
        Ask the agent about this card's work. It can read the worktree but does
        not change anything. To change the work, request changes or run the card
        again.
      </p>
      <ol
        aria-live="polite"
        className="mt-3 max-h-[50dvh] space-y-3 overflow-y-auto text-sm"
      >
        {data.messages.length === 0 && !data.pending && (
          <li className="text-muted-foreground">No messages yet.</li>
        )}
        {data.messages.map((item) => (
          <li
            key={item.id}
            data-role={item.role}
            className={`rounded-md border p-3 ${item.role === "user" ? "ml-8 border-primary/30 bg-primary/10" : item.role === "error" ? "mr-8 border-destructive/30 bg-destructive/10 text-destructive" : "mr-8 border-border bg-accent/10"}`}
          >
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {item.role === "user"
                ? "You"
                : item.role === "error"
                  ? "Agent failed"
                  : "Agent"}
            </div>
            {item.role === "agent" ? (
              <Markdown source={item.body} className="leading-6" />
            ) : (
              <p className="whitespace-pre-wrap">{item.body}</p>
            )}
          </li>
        ))}
        {data.pending && (
          <li role="status" className="mr-8 text-xs text-muted-foreground">
            Agent is thinking…
          </li>
        )}
        <div ref={end} />
      </ol>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message the agent"
          value={draft}
          rows={3}
          maxLength={4000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Ask about this card (⌘/Ctrl+Enter to send)"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
        <Button
          type="submit"
          disabled={!draft.trim() || sending || data.pending}
        >
          Send
        </Button>
      </form>
    </section>
  );
}
