export type PullRequest = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  updatedAt: string;
  createdAt?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  author?: { login?: string } | null;
  labels?: { name: string; color?: string }[];
  assignees?: { login: string }[];
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  checks?: string | null;
  card?: { id: string; title: string; status: string; prChecks: string | null } | null;
};

export type Filters = {
  query: string;
  author: string;
  label: string;
  assignee: string;
  review: string; // "" | APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | none
  checks: string; // "" | passing | failing | pending
  draft: string; // "" | draft | ready
  conflicts: string; // "" | conflicting | clean
  card: string; // "" | with | without
};
export const noFilters: Filters = { query: "", author: "", label: "", assignee: "", review: "", checks: "", draft: "", conflicts: "", card: "" };

export const sorts = {
  newest: "Newest",
  oldest: "Oldest",
  updated: "Recently updated",
  stale: "Least recently updated",
  largest: "Most lines changed",
  smallest: "Fewest lines changed",
} as const;
export type Sort = keyof typeof sorts;

const time = (value?: string | null) => (value ? Date.parse(value) : 0);
const size = (pr: PullRequest) => (pr.additions ?? 0) + (pr.deletions ?? 0);

/** GitHub-style search: free words match title, number, author, branch and labels; `key:value` words narrow like GitHub's qualifiers. */
function matchesQuery(pr: PullRequest, query: string): boolean {
  const haystack = [pr.title, `#${pr.number}`, pr.author?.login, pr.headRefName, ...(pr.labels ?? []).map((l) => l.name)].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => {
    const [key, ...rest] = word.split(":");
    const value = rest.join(":");
    if (rest.length && value) {
      if (key === "author") return pr.author?.login?.toLowerCase() === value;
      if (key === "label") return (pr.labels ?? []).some((l) => l.name.toLowerCase() === value);
      if (key === "assignee") return (pr.assignees ?? []).some((a) => a.login.toLowerCase() === value);
      if (key === "branch" || key === "head") return pr.headRefName.toLowerCase() === value;
      if (key === "is" && value === "draft") return pr.isDraft;
      if (key === "is" && value === "conflicting") return pr.mergeable === "CONFLICTING";
      if (key === "draft") return pr.isDraft === (value === "true");
    }
    return haystack.includes(word);
  });
}

export function filterPullRequests(pulls: PullRequest[], f: Filters): PullRequest[] {
  return pulls.filter((pr) =>
    (!f.query.trim() || matchesQuery(pr, f.query)) &&
    (!f.author || pr.author?.login === f.author) &&
    (!f.label || (pr.labels ?? []).some((l) => l.name === f.label)) &&
    (!f.assignee || (f.assignee === "none" ? !(pr.assignees ?? []).length : (pr.assignees ?? []).some((a) => a.login === f.assignee))) &&
    (!f.review || (f.review === "none" ? !pr.reviewDecision : pr.reviewDecision === f.review)) &&
    (!f.checks || pr.checks === f.checks) &&
    (!f.conflicts || (f.conflicts === "conflicting" ? pr.mergeable === "CONFLICTING" : pr.mergeable === "MERGEABLE")) &&
    (!f.draft || pr.isDraft === (f.draft === "draft")) &&
    (!f.card || !!pr.card === (f.card === "with")));
}

export function sortPullRequests(pulls: PullRequest[], sort: Sort): PullRequest[] {
  const key: Record<Sort, (a: PullRequest, b: PullRequest) => number> = {
    newest: (a, b) => time(b.createdAt) - time(a.createdAt),
    oldest: (a, b) => time(a.createdAt) - time(b.createdAt),
    updated: (a, b) => time(b.updatedAt) - time(a.updatedAt),
    stale: (a, b) => time(a.updatedAt) - time(b.updatedAt),
    largest: (a, b) => size(b) - size(a),
    smallest: (a, b) => size(a) - size(b),
  };
  return [...pulls].sort((a, b) => key[sort](a, b) || b.number - a.number);
}

/** The distinct values a filter menu offers, from the PRs on the page. */
export function filterOptions(pulls: PullRequest[]) {
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
  return {
    authors: unique(pulls.map((pr) => pr.author?.login)),
    labels: unique(pulls.flatMap((pr) => (pr.labels ?? []).map((l) => l.name))),
    assignees: unique(pulls.flatMap((pr) => (pr.assignees ?? []).map((a) => a.login))),
  };
}
