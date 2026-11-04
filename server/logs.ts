import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
  private file?: string;
  private fileBytes = 0;
  constructor(private readonly limit = 5000) {}

  /** Also appends every line to `file`, rotating at 10 MB and keeping 3 old files, so history survives restarts. */
  persist(file: string, maxBytes = 10 * 1024 * 1024) {
    mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    try { this.fileBytes = statSync(file).size; } catch { this.fileBytes = 0; }
    this.maxBytes = maxBytes;
  }
  private maxBytes = 0;
  private write(entry: LogEntry) {
    if (!this.file) return;
    try {
      const line = `${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.message.replace(/\n/g, "\n    ")}\n`;
      if (this.fileBytes + line.length > this.maxBytes) {
        rmSync(`${this.file}.3`, { force: true });
        for (const n of [2, 1]) { try { renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`); } catch { /* missing */ } }
        try { renameSync(this.file, `${this.file}.1`); } catch { /* missing */ }
        this.fileBytes = 0;
      }
      appendFileSync(this.file, line); this.fileBytes += line.length;
    } catch { /* logging must never break the server */ }
  }

  add(level: LogLevel, message: string) {
    const entry = { seq: ++this.seq, at: new Date().toISOString(), level, message };
    this.entries.push(entry); this.write(entry);
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
