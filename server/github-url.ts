// GitHub remotes and pull request links, parsed without touching the network.

/** `OWNER/REPO` for a GitHub web or Git remote URL, or undefined for anything else. */
export function githubRepo(remote: string | null | undefined): string | undefined {
  const value = (remote ?? "").trim();
  const match = value.match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** A pull request link such as https://github.com/OWNER/REPO/pull/12. */
export function parsePullRequestUrl(url: string): { repo: string; number: number } | undefined {
  const match = url.trim().match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\/?$/);
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : undefined;
}
