import { openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function readLock(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * Exclusive ownership of a data directory. A lock whose recorded PID is no longer
 * running is taken over; a live PID, or a lock without a readable PID, still refuses.
 * A PID reused by an unrelated process also refuses, which is the safe direction.
 */
export function acquireLock(path: string, log: (message: string) => void = console.warn): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const recorded = readLock(path);
    if (recorded === null) continue; // removed between our open and read
    const pid = /^\s*(\d+)\s*$/.exec(recorded)?.[1];
    if (!pid) throw new Error(`Bakery found a lock at ${path} without a PID. Another server may be starting; if not, remove the lock.`);
    if (alive(Number(pid))) throw new Error(`Bakery already owns this data directory (PID ${pid}, lock ${path}).`);
    // Only remove the exact stale lock we inspected, not one another server just wrote.
    if (readLock(path) !== recorded) continue;
    unlinkSync(path);
    log(`Removed stale Bakery lock ${path} from PID ${pid}, which is no longer running.`);
  }
  throw new Error(`Bakery could not acquire ${path}; another server may be starting.`);
}

