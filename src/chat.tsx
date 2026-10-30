import { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  Trash2,
} from "lucide-react";
import { api } from "./api.js";
import { Button } from "./components/ui/button";
import { Markdown } from "./markdown-view.js";
import type { Chat, ChatLive, ChatMessage, ChatPart } from "./model.js";

type ChatState = { messages: ChatMessage[]; live: ChatLive };

/** What the sidebar calls a chat: its few-word topic, else its first line. */
const chatLabel = (chat: Chat) => chat.topic || chat.title || "New chat";
const railKey = "bakery-chat-sidebar";

/** One tool call from the agent: its command on one line, its output behind a disclosure. */
function ToolCall({ part }: { part: Extract<ChatPart, { type: "tool" }> }) {
  return (
    <details
      data-tool={part.name}
      data-status={part.status}
      className="rounded border border-border bg-background/60 text-xs"
    >
      <summary className="cursor-pointer truncate px-2 py-1 font-mono">
        <span className="text-muted-foreground">
          {part.status === "running"
            ? "running"
            : part.status === "error"
              ? "failed"
              : part.name}
        </span>{" "}
        {part.input}
      </summary>
      {part.output && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-2 py-1 font-mono">
          {part.output}
        </pre>
      )}
    </details>
  );
}

function Parts({ parts }: { parts: ChatPart[] }) {
  return (
    <div className="space-y-2">
      {parts.map((part, index) =>
        part.type === "text" ? (
          <Markdown key={index} source={part.text} className="leading-6" />
        ) : (
          <ToolCall key={part.id} part={part} />
        ),
      )}
    </div>
  );
}

/** General-purpose agent chats for one board. The agent can read and change the board through bakery-cli. */
export function ChatView({
  boardId,
  onError,
}: {
  boardId: string;
  onError: (message: string) => void;
}) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(() =>
    sessionStorage.getItem(`bakery-chat-${boardId}`),
  );
  const [state, setState] = useState<ChatState>({ messages: [], live: null });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(railKey) === "collapsed",
  );
  const end = useRef<HTMLDivElement>(null);
  // Latest transcript, whether it finished loading, and chats a send was started for: an empty chat is discarded only when all say it is truly empty.
  const latest = useRef({ count: 0, live: false, loaded: false });
  latest.current.count = state.messages.length;
  latest.current.live = !!state.live;
  const sentTo = useRef(new Set<string>());
  const input = useRef<HTMLTextAreaElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const base = `/boards/${boardId}/chats`;
  const fail = (err: unknown) =>
    onError(err instanceof Error ? err.message : String(err));

  const refresh = async () => {
    try {
      const next = await api<Chat[]>(base);
      setChats(next);
      setChatId((current) =>
        current && next.some((chat) => chat.id === current)
          ? current
          : (next[0]?.id ?? null),
      );
    } catch (err) {
      fail(err);
    }
  };
  useEffect(() => {
    setChats(null);
    void refresh();
  }, [boardId]);
  useEffect(() => {
    if (collapsed) localStorage.setItem(railKey, "collapsed");
    else localStorage.removeItem(railKey);
  }, [collapsed]);
  useEffect(() => {
    if (chatId) sessionStorage.setItem(`bakery-chat-${boardId}`, chatId);
    else sessionStorage.removeItem(`bakery-chat-${boardId}`);
  }, [chatId, boardId]);

  // The transcript comes from one fetch, then the event stream carries the live reply and each saved message.
  useEffect(() => {
    setState({ messages: [], live: null });
    if (!chatId) return;
    let current = true;
    latest.current.loaded = false;
    const url = `${base}/${chatId}`;
    void api<{ messages: ChatMessage[]; live: ChatLive }>(url)
      .then((data) => {
        if (!current) return;
        latest.current.loaded = true;
        setState((previous) => ({
          messages: [
            ...data.messages,
            ...previous.messages.filter(
              (item) => !data.messages.some((saved) => saved.id === item.id),
            ),
          ],
          live: previous.live ?? data.live,
        }));
      })
      .catch((err) => current && fail(err));
    const source = new EventSource(`/api${url}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as
        | { type: "live"; live: ChatLive }
        | { type: "message"; message: ChatMessage }
        | { type: "chat"; chat: Chat };
      if (data.type === "chat") {
        const named = data.chat;
        setChats(
          (previous) =>
            previous?.map((item) =>
              item.id === named.id ? { ...item, ...named } : item,
            ) ?? previous,
        );
      } else if (data.type === "live") {
        setState((previous) => ({ ...previous, live: data.live }));
        if (data.live === null) void refresh();
      } else {
        const message = data.message;
        setState((previous) => ({
          ...previous,
          messages: previous.messages.some((item) => item.id === message.id)
            ? previous.messages
            : [...previous.messages, message],
        }));
      }
    };
    return () => {
      current = false;
      source.close();
      // Leaving a chat (another chat, page or board) discards it when it never got a message.
      const { count, live, loaded } = latest.current;
      if (loaded && count === 0 && !live && !sentTo.current.has(chatId)) {
        setChats(
          (previous) => previous?.filter((c) => c.id !== chatId) ?? previous,
        );
        void api(`${base}/${chatId}`, { method: "DELETE" }).catch(() => {});
      }
    };
  }, [chatId, boardId]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [
    state.messages.length,
    state.live?.parts.length,
    state.live?.parts.at(-1),
  ]);

  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);

  const create = async () => {
    try {
      const chat = await api<Chat>(base, { method: "POST", body: "{}" });
      setChats((previous) => [chat, ...(previous ?? [])]);
      setChatId(chat.id);
      setFocusRequest((n) => n + 1);
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (chat: Chat) => {
    if (!confirm(`Delete "${chatLabel(chat)}" and its history?`)) return;
    try {
      await api(`${base}/${chat.id}`, { method: "DELETE" });
      if (chat.id === chatId) setChatId(null);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };
  const send = async () => {
    const message = draft.trim();
    if (!message || sending || state.live) return;
    setSending(true);
    try {
      let id = chatId;
      if (!id) {
        const chat = await api<Chat>(base, { method: "POST", body: "{}" });
        id = chat.id;
        setChatId(id);
      }
      sentTo.current.add(id);
      await api(`${base}/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      setDraft("");
      void refresh();
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  };
  const busy = !!state.live;
  const empty = state.messages.length === 0 && !state.live;

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-96">
      <nav
        aria-label="Chats"
        data-collapsed={collapsed ? "true" : undefined}
        className={`flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-border ${collapsed ? "w-12 items-center px-1.5 py-3" : "w-56 p-3"}`}
      >
        <div className={`flex gap-1 ${collapsed ? "flex-col" : ""}`}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={collapsed ? "Expand chat list" : "Collapse chat list"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand chat list" : "Collapse chat list"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? (
              <PanelLeftOpen size={14} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={14} aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="New chat"
            title="New chat"
            className={collapsed ? "" : "flex-1"}
            onClick={() => void create()}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            {!collapsed && " New chat"}
          </Button>
        </div>
        {chats?.map((chat) =>
          collapsed ? (
            <button
              key={chat.id}
              onClick={() => setChatId(chat.id)}
              aria-current={chat.id === chatId ? "true" : undefined}
              aria-label={chatLabel(chat)}
              title={chatLabel(chat)}
              className={`relative rounded-md p-2 text-muted-foreground ${chat.id === chatId ? "bg-accent/50 text-foreground" : "hover:bg-accent/30"}`}
            >
              <MessageSquare size={14} aria-hidden="true" />
              {chat.pending && (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
              )}
            </button>
          ) : (
            <div
              key={chat.id}
              className={`group flex items-center rounded-md ${chat.id === chatId ? "bg-accent/50" : "hover:bg-accent/30"}`}
            >
              <button
                onClick={() => setChatId(chat.id)}
                aria-current={chat.id === chatId ? "true" : undefined}
                title={chat.title || undefined}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
              >
                {chatLabel(chat)}
                {chat.pending && (
                  <span className="ml-1 text-muted-foreground">…</span>
                )}
              </button>
              <button
                aria-label={`Delete ${chatLabel(chat)}`}
                onClick={() => void remove(chat)}
                className="p-1.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          ),
        )}
      </nav>
      <section aria-label="Chat" className="flex min-w-0 flex-1 flex-col">
        <ol
          aria-live="polite"
          className="flex-1 space-y-3 overflow-y-auto p-4 text-sm lg:px-8"
        >
          {empty && (
            <li className="text-muted-foreground">
              Ask about this board's cards and tickets, or ask the agent to
              change them. It can also read the repository.
            </li>
          )}
          {state.messages.map((item) => (
            <li
              key={item.id}
              data-role={item.role}
              className={`rounded-md border p-3 ${item.role === "user" ? "ml-8 border-primary/30 bg-primary/10" : item.role === "error" ? "mr-8 border-destructive/30 bg-destructive/10 text-destructive" : "mr-8 border-border bg-accent/10"}`}
            >
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {item.role === "user"
                  ? "You"
                  : item.role === "error"
                    ? "Agent stopped"
                    : "Agent"}
              </div>
              {item.role === "agent" ? (
                <Parts
                  parts={
                    item.parts.length
                      ? item.parts
                      : [{ type: "text", text: item.body }]
                  }
                />
              ) : (
                <p className="whitespace-pre-wrap">{item.body}</p>
              )}
            </li>
          ))}
          {state.live && (
            <li
              data-live="true"
              className="mr-8 rounded-md border border-border bg-accent/10 p-3"
            >
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Agent
              </div>
              {state.live.parts.length ? (
                <Parts parts={state.live.parts} />
              ) : (
                <p role="status" className="text-xs text-muted-foreground">
                  Agent is thinking…
                </p>
              )}
            </li>
          )}
          <div ref={end} />
        </ol>
        <form
          className="flex items-end gap-2 border-t border-border p-3 lg:px-8"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            aria-label="Message the agent"
            value={draft}
            rows={3}
            maxLength={16000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Message the agent (⌘/Ctrl+Enter to send)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void api(`${base}/${chatId}/stop`, {
                  method: "POST",
                  body: "{}",
                }).catch(fail)
              }
            >
              <Square size={13} aria-hidden="true" /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!draft.trim() || sending}>
              Send
            </Button>
          )}
        </form>
      </section>
    </div>
  );
}
