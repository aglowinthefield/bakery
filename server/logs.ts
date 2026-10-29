import { format } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry { seq: number; at: string; level: LogLevel; message: string }

const methods = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;

/**
 * Keeps the newest `limit` console lines of this server process so the Logs view can show them.
 * Output still goes to stdout/stderr (the journal under systemd); this is an in-memory copy that
 * starts empty on every restart.
 */
export class LogBuffer {
  readonly startedAt = new Date().toISOString();
  private entries: LogEntry[] = [];
  private seq = 0;
  constructor(private readonly limit = 2000) {}

  add(level: LogLevel, message: string) {
    this.entries.push({ seq: ++this.seq, at: new Date().toISOString(), level, message });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** Entries newer than `after`, oldest first. */
  since(after = 0): LogEntry[] {
    return this.entries.filter(entry => entry.seq > after);
  }

  /** Wraps the console methods so every line they print is also recorded here. */
  captureConsole(target: Console = console) {
    for (const [method, level] of Object.entries(methods) as [keyof typeof methods, LogLevel][]) {
      const original = target[method].bind(target);
      target[method] = (...args: unknown[]) => { this.add(level, format(...args)); original(...args); };
    }
  }
}
