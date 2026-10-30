import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Square, Trash2 } from "lucide-react";
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
  // The model for the next new chat; an open chat shows and changes its own.
  const [newChoice, setNewChoice] = useState<AgentModel>(defaultChatModel);
  const [models, setModels] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
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
    if (chatId) sessionStorage.setItem(`bakery-chat-${boardId}`, chatId);
    else sessionStorage.removeItem(`bakery-chat-${boardId}`);
  }, [chatId, boardId]);

  // The transcript comes from one fetch, then the event stream carries the live reply and each saved message.
  useEffect(() => {
    setState({ messages: [], live: null });
    if (!chatId) return;
    let current = true;
    const url = `${base}/${chatId}`;
    void api<{ messages: ChatMessage[]; live: ChatLive }>(url)
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
    const source = new EventSource(`/api${url}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as
        | { type: "live"; live: ChatLive }
        | { type: "message"; message: ChatMessage };
      if (data.type === "live") {
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
  const choice: AgentModel = current
    ? { model: current.model, thinking: current.thinking }
    : newChoice;
  const [modelDraft, setModelDraft] = useState(choice.model);
  useEffect(() => setModelDraft(choice.model), [chatId, choice.model]);
  const choose = async (next: AgentModel) => {
    next = { ...next, model: next.model.trim() };
    if (!current) return setNewChoice(next);
    if (next.model === current.model && next.thinking === current.thinking)
      return setModelDraft(current.model);
    try {
      const saved = await api<Chat>(`${base}/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify(next),
      });
      setChats(
        (previous) =>
          previous?.map((chat) =>
            chat.id === saved.id ? { ...chat, ...saved } : chat,
          ) ?? null,
      );
    } catch (err) {
      setModelDraft(current.model);
      fail(err);
    }
  };
  const loadModels = () =>
    void listModels().then((result) => setModels(result.models));

  const create = async () => {
    try {
      const chat = await api<Chat>(base, {
        method: "POST",
        body: JSON.stringify(newChoice),
      });
      setChats((previous) => [chat, ...(previous ?? [])]);
      setChatId(chat.id);
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (chat: Chat) => {
    if (!confirm(`Delete "${chat.title || "New chat"}" and its history?`))
      return;
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
        const chat = await api<Chat>(base, {
          method: "POST",
          body: JSON.stringify(newChoice),
        });
        setChats((previous) => [chat, ...(previous ?? [])]);
        id = chat.id;
        setChatId(id);
      }
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
        className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3"
      >
        <Button variant="outline" size="sm" onClick={() => void create()}>
          <MessageSquarePlus size={14} aria-hidden="true" /> New chat
        </Button>
        {chats?.map((chat) => (
          <div
            key={chat.id}
            className={`group flex items-center rounded-md ${chat.id === chatId ? "bg-accent/50" : "hover:bg-accent/30"}`}
          >
            <button
              onClick={() => setChatId(chat.id)}
              aria-current={chat.id === chatId ? "true" : undefined}
              className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
            >
              {chat.title || "New chat"}
              {chat.pending && (
                <span className="ml-1 text-muted-foreground">…</span>
              )}
            </button>
            <button
              aria-label={`Delete ${chat.title || "New chat"}`}
              onClick={() => void remove(chat)}
              className="p-1.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
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
            placeholder="Pi default"
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
            <option value="">Pi default</option>
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
