import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import type { LogEntry } from "../server/logs.js";

const levels = [
  { value: "debug", label: "Debug and up" },
  { value: "info", label: "Info and up" },
  { value: "warn", label: "Warnings and errors" },
  { value: "error", label: "Errors only" },
] as const;
type Level = (typeof levels)[number]["value"];
const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const levelColor: Record<Level, string> = {
  debug: "text-muted-foreground",
  info: "",
  warn: "text-amber-500",
  error: "text-destructive",
};
const select =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm";

/** The server's own console output since it started, polled every two seconds. */
export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [startedAt, setStartedAt] = useState("");
  const [error, setError] = useState("");
  const [minLevel, setMinLevel] = useState<Level>("debug");
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    let cancelled = false,
      after = 0,
      server = "";
    const poll = async () => {
      try {
        const data = await api<{ startedAt: string; entries: LogEntry[] }>(
          `/logs?after=${after}`,
        );
        if (cancelled) return;
        // A restarted server numbers its lines from 1 again, so start over.
        if (data.startedAt !== server) {
          server = data.startedAt;
          setStartedAt(server);
          if (after > 0) {
            after = 0;
            setEntries([]);
            return poll();
          }
        }
        if (data.entries.length) {
          after = data.entries[data.entries.length - 1].seq;
          setEntries((old) => [...old, ...data.entries].slice(-2000));
        }
        setError("");
      } catch (failure) {
        if (!cancelled) setError(String((failure as Error).message));
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const shown = entries.filter(
    (entry) =>
      rank[entry.level] >= rank[minLevel] &&
      (!needle || entry.message.toLowerCase().includes(needle)),
  );

  // Follow new lines only while the reader is already at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [shown.length]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10">
        <div>
          <h1 className="text-[27px] font-semibold tracking-[-.05em]">Logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This Bakery server's output
            {startedAt &&
              ` since it started ${new Date(startedAt).toLocaleString()}`}
            . The last 2,000 lines are kept.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            aria-label="Filter logs"
            placeholder="Filter"
            className={select}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="Log level"
            className={select}
            value={minLevel}
            onChange={(event) => setMinLevel(event.target.value as Level)}
          >
            {levels.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </header>
      {error && (
        <p role="alert" className="px-6 py-2 text-sm text-destructive lg:px-10">
          Could not load logs: {error}
        </p>
      )}
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            40;
        }}
        className="min-h-0 flex-1 overflow-auto px-6 py-4 font-mono text-xs lg:px-10"
      >
        {shown.length === 0 ? (
          <p className="text-muted-foreground">
            {entries.length ? "No lines match." : "No output yet."}
          </p>
        ) : (
          shown.map((entry) => (
            <div
              key={entry.seq}
              data-log-level={entry.level}
              className={`whitespace-pre-wrap break-words ${levelColor[entry.level]}`}
            >
              <span className="text-muted-foreground">
                {new Date(entry.at).toLocaleTimeString()}
              </span>{" "}
              <span className="inline-block w-12 uppercase">{entry.level}</span>{" "}
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
