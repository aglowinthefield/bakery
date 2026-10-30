import { execFile, execFileSync } from "node:child_process";

// Updates for a hosted Bakery checkout. A timer fetches origin/main (scripts/update.sh); this lists what the fetch
// brought in, plus anything merged into the checked-out main since the server started (approving a card merges it
// locally), so the UI can show a changelog. It installs on request or by itself while nothing is running.
// Installing leaves the restart to the caller, which drains active runs first.

export type UpdateCommit = { sha: string; subject: string };
export type UpdateState = { commits: UpdateCommit[]; installing: boolean; error: string | null };
type Install = () => Promise<void>;

/** Runs `scripts/update.sh install` (fast-forward, npm install, UI build) in `root`. */
export const installScript = (root: string): Install => () => new Promise((done, fail) => {
  execFile("bash", ["scripts/update.sh", "install"], { cwd: root, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
    if (!error) return done();
    const detail = stderr.trim().split("\n").slice(-5).join("\n") || error.message;
    fail(new Error(detail));
  });
});

export class Updates {
  private commits: UpdateCommit[] = [];
  private installing = false;
  private error: string | null = null;
  // HEAD and origin/main at the last failed install, so the idle check does not retry the same failure every tick.
  private failedAt: string | null = null;
  // The commit the server started on. Local merges move HEAD past it without touching origin/main.
  private startHead: string | null;

  constructor(private root: string, private install: Install, private onInstalled: () => void) {
    this.startHead = this.revParse("HEAD");
  }

  get state(): UpdateState { return { commits: this.commits, installing: this.installing, error: this.error }; }

  /**
   * Re-reads the pending commits: those on origin/main that the checked-out main lacks, and those merged into main
   * since the server started. Only `main` checkouts update.
   */
  refresh(): void {
    try {
      if (this.git("rev-parse", "--abbrev-ref", "HEAD") !== "main") { this.commits = []; return; }
      // Newest first: what origin/main would bring in, then what was merged locally since startup.
      const ranges = [this.originMain() && "HEAD..refs/remotes/origin/main", this.startHead && `${this.startHead}..HEAD`];
      const log = ranges.filter((range): range is string => !!range).map(range => this.git("log", "--format=%h%x09%s", range)).filter(Boolean).join("\n");
      this.commits = log ? log.split("\n").map(line => { const [sha, ...subject] = line.split("\t"); return { sha, subject: subject.join("\t") }; }) : [];
    } catch (error) {
      this.commits = [];
      console.warn(`Update check failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Called on a timer. Installs pending commits without asking when `idle` (no runs and no agent review). */
  async tick(idle: boolean): Promise<void> {
    this.refresh();
    if (!idle || this.installing || this.commits.length === 0 || this.target() === this.failedAt) return;
    console.log(`Installing ${this.commits.length} update${this.commits.length === 1 ? "" : "s"} while idle.`);
    await this.apply();
  }

  /** Installs pending commits, then hands over to `onInstalled` to drain and restart. */
  /** Throws right away when nothing is pending, so the API can answer 400. */
  apply(): Promise<void> {
    if (this.installing) return Promise.resolve();
    this.refresh();
    if (this.commits.length === 0) throw new Error("Already up to date");
    this.installing = true;
    this.error = null;
    return this.run();
  }

  private async run(): Promise<void> {
    try {
      await this.install();
    } catch (error) {
      this.installing = false;
      // Read after the attempt: a fast-forward may have moved HEAD before a later step failed.
      this.failedAt = this.target();
      this.error = error instanceof Error ? error.message : String(error);
      console.error(`Update failed: ${this.error}`);
      return;
    }
    console.log(`Installed update (${this.commits.length} commit${this.commits.length === 1 ? "" : "s"}); restarting once active runs finish.`);
    this.onInstalled();
  }

  /** What an install would move to: the checked-out main and the fetched origin/main. */
  private target(): string { return `${this.revParse("HEAD")} ${this.originMain()}`; }

  private originMain(): string | null { return this.revParse("refs/remotes/origin/main"); }

  private revParse(ref: string): string | null {
    try { return this.git("rev-parse", "--verify", "-q", ref); } catch { return null; }
  }

  private git(...args: string[]): string {
    return execFileSync("git", ["-C", this.root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
}
