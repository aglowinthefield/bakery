export type RemoteHost = "github" | "gitlab" | "other";

/** Short, readable label for a repository web URL, e.g. "owner/repo" on known Git hosts. */
export function describeRemote(value: string): { host: RemoteHost; hostname: string; label: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { host: "other", hostname: "", label: value };
  }
  const hostname = url.hostname.replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^\/+/, "");
  const host: RemoteHost = hostname === "github.com" ? "github" : hostname === "gitlab.com" ? "gitlab" : "other";
  if (host === "other" || !path) return { host, hostname, label: path ? `${hostname}/${path}` : hostname };
  return { host, hostname, label: path };
}

/** Whether Bakery can list this repository's pull requests: only GitHub remotes, through `gh`. */
export function supportsPullRequests(board: { remoteUrl?: string }): boolean {
  return !!board.remoteUrl && describeRemote(board.remoteUrl).host === "github";
}
