import { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  Trash2,
} from "lucide-react";
import { api, listModels } from "./api.js";
import {
  defaultChatModel,
  thinkingLevels,
  type AgentModel,
  type ThinkingLevel,
} from "../server/agent-models.js";
import { Button } from "./components/ui/button";
import { Markdown } from "./markdown-view.js";
import type { Chat, ChatLive, ChatMessage, ChatPart } from "./model.js";

type ChatState = { messages: ChatMessage[]; live: ChatLive };

/** What the sidebar calls a chat: its few-word topic, else its first line. */
const chatLabel = (chat: Chat) => chat.topic || chat.title || "New chat";
const railKey = "bakery-chat-sidebar";
// How often the chat list refreshes its per-chat unread counts, and how long a dropped event stream waits to reconnect.
const listPollMs = 3000;
const reconnectMs = 3000;
/** The operator is looking at the page: it is visible and has focus. */
const looking = () =>
  document.visibilityState === "visible" && document.hasFocus();
/** Sums the unread turns over a board's chats. */
export const unreadTotal = (chats: Pick<Chat, "unread">[]) =>
  chats.reduce((sum, chat) => sum + (chat.unread ?? 0), 0);

/** A small count of finished turns the operator has not seen. */
function UnreadBadge({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  return (
    <span
      data-unread={count}
      aria-label={`${count} unread`}
      title={`${count} unread ${count === 1 ? "reply" : "replies"}`}
      className={`shrink-0 rounded-full bg-primary px-1.5 font-mono text-[10px] leading-4 text-primary-foreground ${className}`}
    >
      {count}
    </span>
  );
}

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
  boardUnread,
  onUnreadChange,
}: {
  boardId: string;
  onError: (message: string) => void;
  /** The board's unread total as last polled; when it changes, another chat finished a turn, so the list reloads. */
  boardUnread?: number;
  onUnreadChange?: (total: number) => void;
}) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(() =>
    sessionStorage.getItem(`bakery-chat-${boardId}`),
  );
  const [state, setState] = useState<ChatState>({ messages: [], live: null });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // The model for the next new chat; an open chat shows and changes its own.
  const [newChoice, setNewChoice] = useState<AgentModel>(defaultChatModel);
  const [models, setModels] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(railKey) === "collapsed",
  );
  const end = useRef<HTMLDivElement>(null);
  // Whether the open chat is known to hold a message (messages are never removed, so this cannot go stale the wrong way), and the chats with a first send in flight.
  const latest = useRef({ count: 0, live: false });
  latest.current.count = state.messages.length;
  latest.current.live = !!state.live;
  const sendsInFlight = useRef(new Set<string>());
  const openId = useRef<string | null>(chatId);
  openId.current = chatId;
  const input = useRef<HTMLTextAreaElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [isLooking, setIsLooking] = useState(looking);
  const lookingNow = useRef(isLooking);
  lookingNow.current = isLooking;
  const base = `/boards/${boardId}/chats`;
  const fail = (err: unknown) =>
    onError(err instanceof Error ? err.message : String(err));
  // The open event stream registers a view with the server, which counts a finished turn as unread only while no
  // registered view is looking at the chat. Changes are reported only once the server holds the registration.
  // Updates carry increasing revisions, so the server ignores one that arrives after a later one. If an update fails
  // or the server no longer knows the view, the stream is dropped and reopened: closing it makes the server forget
  // the view, and the new stream registers whatever the operator is doing then.
  const stream = useRef<{
    url: string;
    viewer: string;
    looking: boolean;
    revision: number;
    open: boolean;
    drop: () => void;
  } | null>(null);
  const report = (looking: boolean) => {
    const current = stream.current;
    if (!current?.open || current.looking === looking) return;
    current.looking = looking;
    const revision = ++current.revision;
    void api<{ known?: boolean }>(`${current.url}/view`, {
      method: "POST",
      body: JSON.stringify({ viewer: current.viewer, looking, revision }),
    }).then(
      (result) => {
        if (result.known === false) current.drop();
      },
      () => current.drop(),
    );
  };

  const discard = async (id: string) => {
    if (sendsInFlight.current.has(id)) return; // send() retries once its request settles
    try {
      const result = await api<{ discarded: boolean }>(
        `${base}/${id}/discard`,
        { method: "POST", body: "{}" },
      );
      if (result.discarded)
        setChats(
          (previous) => previous?.filter((c) => c.id !== id) ?? previous,
        );
    } catch {
      // Cleanup is best effort; the chat stays listed.
    }
  };
  const refresh = async () => {
    try {
      const listed = await api<Chat[]>(base);
      // The open chat's count is being cleared while the operator looks at it.
      const next = listed.map((item) =>
        lookingNow.current && item.id === openId.current && item.unread
          ? { ...item, unread: 0 }
          : item,
      );
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
  const polledUnread = useRef(boardUnread);
  useEffect(() => {
    if (polledUnread.current === boardUnread) return;
    polledUnread.current = boardUnread;
    void refresh();
  }, [boardUnread]);
  // Polling the list catches counts that move between chats while the board's total stays the same.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, listPollMs);
    return () => clearInterval(timer);
  }, [boardId]);
  useEffect(() => {
    if (!chats) return;
    // The parent's total follows this list, which is already current, so that echo should not reload it.
    polledUnread.current = unreadTotal(chats);
    onUnreadChange?.(polledUnread.current);
  }, [chats]);
  useEffect(() => {
    const update = () => setIsLooking(looking());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  // Looking at a chat marks it read; the server also skips counting turns that finish while it is looked at.
  useEffect(() => {
    if (!chatId) return;
    if (isLooking)
      setChats(
        (previous) =>
          previous?.map((item) =>
            item.id === chatId && item.unread ? { ...item, unread: 0 } : item,
          ) ?? previous,
      );
    report(isLooking);
  }, [chatId, isLooking]);
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
    const url = `${base}/${chatId}`;
    const load = () =>
      api<{ messages: ChatMessage[]; live: ChatLive }>(url)
        .then((data) => {
          if (!current) return;
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
    void load();
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      // Each connection is a fresh view opened with the current state; the browser's own retry would reuse the
      // first URL and its stale looking state, which could clear a reply that arrived while the operator was away.
      const registration = {
        url,
        viewer: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        looking: lookingNow.current,
        revision: 0,
        open: false,
        drop: () => {},
      };
      stream.current = registration;
      const events = new EventSource(
        `/api${url}/events?viewer=${registration.viewer}&looking=${registration.looking ? 1 : 0}`,
      );
      source = events;
      events.onopen = () => {
        registration.open = true;
        report(lookingNow.current);
      };
      registration.drop = () => {
        if (stream.current !== registration) return; // already dropped or replaced
        events.close();
        registration.open = false;
        stream.current = null;
        clearTimeout(retry);
        retry = setTimeout(() => {
          if (!current) return;
          connect();
          void load(); // catch up on messages saved while disconnected
        }, reconnectMs);
      };
      events.onerror = registration.drop;
      events.onmessage = (event) => {
        const data = JSON.parse(event.data) as
          | { type: "live"; live: ChatLive }
          | { type: "message"; message: ChatMessage }
          | { type: "chat"; chat: Chat };
        if (data.type === "chat") {
          // A count that arrives while the operator is looking is already being cleared.
          const named =
            lookingNow.current && data.chat.id === chatId
              ? { ...data.chat, unread: 0 }
              : data.chat;
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
    };
    connect();
    return () => {
      current = false;
      clearTimeout(retry);
      source?.close();
      stream.current = null;
      // Leaving a chat (another chat, page or board) asks the server to discard it if it is still empty.
      // The server decides, so a stale view here cannot delete a message sent from another tab.
      const { count, live } = latest.current;
      if (count === 0 && !live) void discard(chatId);
    };
  }, [chatId, boardId]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [
    state.messages.length,
    state.live?.parts.length,
    state.live?.parts.at(-1),
  ]);

  const current = chats?.find((chat) => chat.id === chatId);
  // Choices the operator made that the server has not confirmed yet, per chat. They win over the saved values on screen.
  const [wanted, setWanted] = useState<Record<string, AgentModel>>({});
  const wantedRef = useRef<Record<string, AgentModel>>({});
  // Saves run one at a time per chat, each sending the newest choice, so a slow response never overwrites a newer pick.
  const saves = useRef<Record<string, Promise<boolean>>>({});
  const choice: AgentModel =
    (chatId && wanted[chatId]) ||
    (current
      ? { model: current.model, thinking: current.thinking }
      : newChoice);
  const [modelDraft, setModelDraft] = useState(choice.model);
  useEffect(() => setModelDraft(choice.model), [chatId, choice.model]);
  const settle = (id: string, sent: AgentModel | null) => {
    // Forget the wanted choice unless the operator has picked again since this save began.
    const latestChoice = wantedRef.current[id];
    if (!sent || (latestChoice && same(latestChoice, sent))) {
      delete wantedRef.current[id];
      setWanted((previous) => {
        const { [id]: _, ...rest } = previous;
        return rest;
      });
    }
  };
  const same = (a: AgentModel, b: AgentModel) =>
    a.model === b.model && a.thinking === b.thinking;
  const choose = (next: AgentModel) => {
    next = { ...next, model: next.model.trim() };
    if (!current || !chatId) return setNewChoice(next);
    const id = chatId;
    if (same(next, choice)) return setModelDraft(choice.model);
    wantedRef.current[id] = next;
    setWanted((previous) => ({ ...previous, [id]: next }));
    saves.current[id] = (saves.current[id] ?? Promise.resolve(true)).then(
      async () => {
        const sending = wantedRef.current[id];
        if (!sending) return true;
        try {
          const saved = await api<Chat>(`${base}/${id}`, {
            method: "PATCH",
            body: JSON.stringify(sending),
          });
          setChats(
            (previous) =>
              previous?.map((chat) =>
                chat.id === id
                  ? { ...chat, model: saved.model, thinking: saved.thinking }
                  : chat,
              ) ?? null,
          );
          settle(id, sending);
          return true;
        } catch (err) {
          // Drop the pick only if nothing newer was chosen; a newer pick is saved by the next queued request.
          const newer = wantedRef.current[id];
          if (!newer || same(newer, sending)) settle(id, sending);
          fail(err);
          return false;
        }
      },
    );
  };
  /** Resolves once every choice made for this chat is saved; false if a save failed. */
  const flushChoice = async (id: string) => {
    let ok = true;
    while (wantedRef.current[id]) {
      const pending = saves.current[id];
      ok = (await pending) && ok;
      if (saves.current[id] === pending && wantedRef.current[id]) break;
    }
    return ok;
  };
  const loadModels = () =>
    void listModels().then((result) => setModels(result.models));
  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);

  const create = async () => {
    try {
      const chat = await api<Chat>(base, {
        method: "POST",
        body: JSON.stringify(newChoice),
      });
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
    let id = chatId;
    try {
      if (id && !(await flushChoice(id))) return;
      if (!id) {
        const chat = await api<Chat>(base, {
          method: "POST",
          body: JSON.stringify(newChoice),
        });
        setChats((previous) => [chat, ...(previous ?? [])]);
        id = chat.id;
        setChatId(id);
      }
      sendsInFlight.current.add(id);
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
      if (id) {
        sendsInFlight.current.delete(id);
        // Left while the send was pending: the server keeps the chat if the message was saved, discards it if the send failed.
        if (openId.current !== id) void discard(id);
      }
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
              aria-label={`${chatLabel(chat)}${chat.unread ? `, ${chat.unread} unread` : ""}`}
              title={chatLabel(chat)}
              className={`relative rounded-md p-2 text-muted-foreground ${chat.id === chatId ? "bg-accent/50 text-foreground" : "hover:bg-accent/30"}`}
            >
              <MessageSquare size={14} aria-hidden="true" />
              {chat.unread ? (
                <UnreadBadge
                  count={chat.unread}
                  className="absolute right-0 top-0 px-1 text-[9px] leading-3"
                />
              ) : (
                chat.pending && (
                  <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
                )
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
              {!!chat.unread && <UnreadBadge count={chat.unread} />}
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
        <div className="flex items-center gap-2 border-t border-border px-3 pt-2 text-xs lg:px-8">
          <datalist id="chat-models">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <input
            aria-label="Chat model"
            list="chat-models"
            value={modelDraft}
            disabled={!!chatId && !current}
            onFocus={loadModels}
            onChange={(event) => setModelDraft(event.target.value)}
            onBlur={() => void choose({ ...choice, model: modelDraft })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void choose({ ...choice, model: modelDraft });
              }
            }}
            placeholder={defaultChatModel.model}
            className="w-64 min-w-0 rounded-md border border-border bg-background px-2 py-1 font-mono"
          />
          <select
            aria-label="Chat thinking"
            value={choice.thinking}
            disabled={!!chatId && !current}
            onChange={(event) =>
              void choose({
                model: modelDraft,
                thinking: event.target.value as ThinkingLevel | "",
              })
            }
            className="rounded-md border border-border bg-background px-2 py-1"
          >
            <option value="">Default ({defaultChatModel.thinking})</option>
            {thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">
            {current ? "Used from this chat's next message" : "For new chats"}
          </span>
        </div>
        <form
          className="flex items-end gap-2 p-3 pt-2 lg:px-8"
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
