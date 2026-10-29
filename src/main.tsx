import { BrandIcon } from "./brand-icon";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  Archive,
  CircleCheck,
  CirclePause,
  CircleX,
  Eye,
  Inbox,
  ListTodo,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  GitBranch,
  Bot,
  GitPullRequest,
  Hourglass,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sun,
  BarChart3,
  ScrollText,
  Globe2,
  ExternalLink,
  Github,
  Gitlab,
  XCircle,
  X,
  Kanban,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import "highlight.js/styles/github-dark.css";
import "./style.css";
import { api, date } from "./api.js";
import {
  agentPhases,
  emptyAgentModels,
  thinkingLevels,
  type AgentModels,
  type AgentPhase,
  type ThinkingLevel,
} from "../server/agent-models.js";
import { AgentBadge, reworkSummary } from "./attempts.js";
import { formatCost } from "./usage.js";
import { CardDetails } from "./card-details.js";
import { PullRequests } from "./pull-requests.js";
import { Statistics } from "./statistics.js";
import { LocalMerges } from "./local-merges.js";
import { RepoBadge } from "./repo-badge.js";
import { needsYouStatuses, reviewOrder, Today } from "./today.js";
import { markdownToPlainText } from "./markdown.js";
import {
  repoColors,
  repoColorVar,
  repoIcons,
  repoTint,
  repoName,
  type RepoColor,
  type RepoIcon,
} from "./repo-appearance.js";
import {
  describeRemote,
  supportsPullRequests,
  type RemoteHost,
} from "./remote-link.js";
import {
  byPriority,
  priorities,
  priorityLabel,
  cardActivity,
  countKey,
  dropTargets,
  needsYourReview,
  reviewWaitLabels,
  type BakerySettings,
  type Board,
  type Card,
  type CountKey,
  type MergeConflict,
  type Priority,
  type Status,
  waitingOn,
} from "./model.js";
import { formatRoute, parseRoute, type RouteView } from "./route.js";
import { Logs } from "./logs.js";
import { themeNames, themes } from "./themes.js";
import { UpdateNotice } from "./update-notice.js";

// The database is authoritative. Storage only avoids a palette flash on repeat visits.
// Case-insensitive match on title, description, or card ID prefix.
// The machine the server runs on: repositories and merges live on its disk.
function ServerHost() {
  const [host, setHost] = useState("");
  useEffect(() => {
    void api<{ hostname?: string }>("/status")
      .then((status) => setHost(status.hostname ?? ""))
      .catch(() => {});
  }, []);
  return <span data-testid="server-host">{host || "Bakery"}</span>;
}

function filterCards(cards: Card[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter(
    (card) =>
      card.id.toLowerCase().startsWith(needle) ||
      card.title.toLowerCase().includes(needle) ||
      card.body.toLowerCase().includes(needle),
  );
}

// Per-tab state in sessionStorage survives a page reload, such as Vite reloading
// after Bakery merges a card into its own checkout, without leaking into other tabs.
function readTab(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeTab(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Without storage, a reload opens the last viewed repo with no card open.
  }
}

// Older servers send no density; anything unknown renders as Default.
function applyDensity(value: BakerySettings["density"] | undefined) {
  const density = value === "compact" || value === "cozy" ? value : "default";
  const root = document.documentElement;
  if (density === "default") delete root.dataset.density;
  else root.dataset.density = density;
  try {
    localStorage.setItem("bakery-density", density);
  } catch {
    // Private or full storage must not prevent settings from loading or saving.
  }
}

function cacheTheme(theme: BakerySettings["theme"]) {
  try {
    localStorage.setItem("bakery-theme", theme);
  } catch {
    // Private or full storage must not prevent settings from loading or saving.
  }
}

type Lane = {
  id: Status | "agent" | "waiting";
  status: Status;
  label: string;
  icon: LucideIcon;
};
const columns: Lane[] = [
  { id: "triage", status: "triage", label: "Triage", icon: Inbox },
  { id: "ready", status: "ready", label: "Ready", icon: ListTodo },
  { id: "running", status: "running", label: "Running", icon: LoaderCircle },
  { id: "review", status: "review", label: "Review", icon: Eye },
  { id: "failed", status: "failed", label: "Failed", icon: CircleX },
  { id: "done", status: "done", label: "Done", icon: CircleCheck },
  { id: "archived", status: "archived", label: "Archive", icon: Archive },
];
/**
 * On a pull request board the Review lane holds only cards that need you. Cards an agent still has (a review, a CI
 * fix) and cards waiting on GitHub get lanes of their own, still Review underneath.
 */
const pullRequestLanes: Lane[] = columns.flatMap((lane) =>
  lane.id === "review"
    ? [
        lane,
        { id: "agent", status: "review", label: "Agent reviewing", icon: Bot },
        {
          id: "waiting",
          status: "review",
          label: "Waiting on GitHub",
          icon: GitPullRequest,
        },
      ]
    : [lane],
);
const laneOf = (card: Card, split: boolean): Lane["id"] =>
  card.status === "interrupted"
    ? "failed"
    : split && card.status === "review" && card.reviewWait
      ? card.reviewWait === "github"
        ? "waiting"
        : "agent"
      : card.status;

// The sidebar condenses the lanes into the stages you scan for. Done and Archive are left out;
// Failed only appears when something failed or was interrupted.
const sidebarCounts: {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Supplies the lane color. */
  color: Status;
  statuses: CountKey[];
  hideEmpty?: boolean;
}[] = [
  {
    id: "backlog",
    label: "Backlog",
    icon: ListTodo,
    color: "ready",
    statuses: ["triage", "ready"],
  },
  {
    id: "in-progress",
    label: "In progress",
    icon: LoaderCircle,
    color: "running",
    // Review cards an agent, CI or GitHub still has are in progress, not waiting on you.
    statuses: ["running", "reviewWaiting"],
  },
  {
    id: "review",
    label: "Review",
    icon: Eye,
    color: "review",
    statuses: ["review"],
  },
  {
    id: "failed",
    label: "Failed",
    icon: CircleX,
    color: "failed",
    statuses: ["failed", "interrupted"],
    hideEmpty: true,
  },
];
const remoteIcons: Record<RemoteHost, LucideIcon> = {
  github: Github,
  gitlab: Gitlab,
  other: Globe2,
};

function RemoteLink({ url }: { url: string }) {
  const remote = describeRemote(url);
  const Icon = remoteIcons[remote.host];
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      aria-label={`Remote repository: ${remote.label}`}
      className="group mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon size={13} className="shrink-0" aria-hidden="true" />
      <span className="truncate font-mono text-foreground">{remote.label}</span>
      <ExternalLink
        size={12}
        className="shrink-0 opacity-60 group-hover:opacity-100"
        aria-hidden="true"
      />
    </a>
  );
}

function RepositoryPathInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!focused || !/^(\/|~[\\/]|[A-Za-z]:[\\/])/.test(value)) {
      setSuggestions([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void api<string[]>(`/path-suggestions?path=${encodeURIComponent(value)}`)
        .then((paths) => {
          if (current) setSuggestions(paths);
        })
        .catch(() => {
          if (current) setSuggestions([]);
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [value, focused]);
  const visible = focused && !dismissed && suggestions.length > 0;
  const choose = (path: string) => {
    onChange(path);
    setSuggestions([]);
    setActive(-1);
    setDismissed(false);
  };
  return (
    <div className="min-w-0 flex-1">
      <input
        required
        role="combobox"
        aria-label="Repository root"
        aria-autocomplete="list"
        aria-controls="repository-path-options"
        aria-expanded={visible}
        aria-activedescendant={
          visible && active >= 0
            ? `repository-path-option-${active}`
            : undefined
        }
        autoComplete="off"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setSuggestions([]);
          setActive(-1);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => {
          setFocused(false);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && visible) {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
            setActive(-1);
          }
          if (event.key === "ArrowDown" && visible) {
            event.preventDefault();
            setActive((index) => (index + 1) % suggestions.length);
          }
          if (event.key === "ArrowUp" && visible) {
            event.preventDefault();
            setActive((index) =>
              index <= 0 ? suggestions.length - 1 : index - 1,
            );
          }
          if (event.key === "Enter" && visible && active >= 0) {
            event.preventDefault();
            choose(suggestions[active]);
          }
        }}
        placeholder="~/code/project"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      {visible && (
        <div
          id="repository-path-options"
          role="listbox"
          aria-label="Directory suggestions"
          className="mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {suggestions.map((path, index) => (
            <button
              key={path}
              id={`repository-path-option-${index}`}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              type="button"
              className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${index === active ? "bg-accent" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(path)}
            >
              {path}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const phaseLabels: Record<AgentPhase, string> = {
  work: "Card runs",
  conflict: "Conflict fixes",
  review: "Agent review",
  draft: "PR drafts",
};
// Shared across dialogs; listing spawns Pi, so only ask once a model field is used.
let modelList: Promise<{ models: string[]; error?: string }> | undefined;
function AgentModelFields({
  scope,
  value,
  inherited,
  disabled,
  onSave,
}: {
  scope: string;
  value: AgentModels;
  inherited?: AgentModels;
  disabled: boolean;
  onSave: (next: AgentModels) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState("");
  const loadModels = () => {
    modelList ??= api<{ models: string[]; error?: string }>("/models").catch(
      (err) => ({ models: [], error: String(err) }),
    );
    void modelList.then((result) => {
      if (result.error) modelList = undefined;
      setModels(result.models);
      setModelError(result.error ?? "");
    });
  };
  const inheritedLabel = (text: string) =>
    inherited ? `Global: ${text || "Pi default"}` : "Pi default";
  const changed = JSON.stringify(draft) !== JSON.stringify(value);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          work: { ...draft.work, model: draft.work.model.trim() },
          conflict: { ...draft.conflict, model: draft.conflict.model.trim() },
          review: { ...draft.review, model: draft.review.model.trim() },
          draft: { ...draft.draft, model: draft.draft.model.trim() },
        });
      }}
    >
      <datalist id={`${scope}-models`}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {agentPhases.map((phase) => (
        <div
          key={phase}
          className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-2 text-xs"
        >
          <span>{phaseLabels[phase]}</span>
          <input
            aria-label={`${phaseLabels[phase]} model`}
            list={`${scope}-models`}
            value={draft[phase].model}
            onFocus={loadModels}
            onChange={(event) =>
              setDraft({
                ...draft,
                [phase]: { ...draft[phase], model: event.target.value },
              })
            }
            disabled={disabled}
            placeholder={inheritedLabel(inherited?.[phase].model ?? "")}
            className="min-w-0 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
          />
          <select
            aria-label={`${phaseLabels[phase]} thinking`}
            value={draft[phase].thinking}
            onChange={(event) =>
              setDraft({
                ...draft,
                [phase]: {
                  ...draft[phase],
                  thinking: event.target.value as ThinkingLevel | "",
                },
              })
            }
            disabled={disabled}
            className="rounded-md border border-border bg-background px-2 py-1"
          >
            <option value="">
              {inherited
                ? `Inherit (${inheritedLabel(inherited[phase].thinking)})`
                : "Inherit (Pi default)"}
            </option>
            {thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      ))}
      {modelError && (
        <p className="mt-2 text-xs text-muted-foreground">
          Model suggestions unavailable. {modelError}
        </p>
      )}
      <Button
        type="submit"
        variant="outline"
        className="mt-3"
        disabled={disabled || !changed}
      >
        Save models
      </Button>
    </form>
  );
}
// The entry module renders App, so edits here hot-swap instead of reloading the page.
export function App() {
  const [initialRoute] = useState(() => parseRoute(location.pathname));
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [settings, setSettings] = useState<BakerySettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [repoPath, setRepoPath] = useState("");
  const [iconDraft, setIconDraft] = useState<RepoIcon>("sprinkle_donut");
  const [colorDraft, setColorDraft] = useState<RepoColor>("violet");
  const [repoCheck, setRepoCheck] = useState<{
    path: string;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if ((!addingRepo && !editingBoard) || !repoPath.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      void api<{ root: string }>(
        `/repository-root?path=${encodeURIComponent(repoPath)}`,
      )
        .then(() => {
          if (current) setRepoCheck({ path: repoPath });
        })
        .catch((err) => {
          if (current) setRepoCheck({ path: repoPath, error: String(err) });
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [repoPath, addingRepo, editingBoard]);
  const [cards, setCards] = useState<Card[]>([]);
  /** The board whose cards `cards` holds; null until its first fetch lands, so an unloaded board is not shown as empty. */
  const [loadedBoard, setLoadedBoard] = useState<string | null>(null);
  // Today is the landing page until you pick a board; the last choice persists.
  const [view, setView] = useState<RouteView>(() => {
    if (initialRoute) return initialRoute.view;
    const saved = readTab("bakery-view") ?? localStorage.getItem("bakery-view");
    return saved === "board" ||
      saved === "pulls" ||
      saved === "stats" ||
      saved === "logs"
      ? saved
      : "today";
  });
  const [reposCollapsed, setReposCollapsed] = useState(
    () => localStorage.getItem("bakery-repos-collapsed") === "true",
  );
  const toggleRepos = () => {
    const next = !reposCollapsed;
    setReposCollapsed(next);
    localStorage.setItem("bakery-repos-collapsed", String(next));
  };
  // Repos start collapsed except the open one; the user's toggles persist.
  const [repoOpen, setRepoOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("bakery-repo-open") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggleRepoOpen = (id: string, open: boolean) =>
    setRepoOpen((previous) => {
      const next = { ...previous, [id]: !open };
      localStorage.setItem("bakery-repo-open", JSON.stringify(next));
      return next;
    });
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.min(
      480,
      Math.max(
        180,
        Number(localStorage.getItem("bakery-sidebar-width")) || 228,
      ),
    ),
  );
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem("bakery-sidebar-hidden") === "true",
  );
  const toggleSidebar = () => {
    const next = !sidebarHidden;
    setSidebarHidden(next);
    localStorage.setItem("bakery-sidebar-hidden", String(next));
  };
  const startSidebarResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(480, Math.max(180, startWidth + e.clientX - startX));
      setSidebarWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("bakery-sidebar-width", String(width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [allCards, setAllCards] = useState<Card[]>([]);
  const [since] = useState(
    () =>
      localStorage.getItem("bakery-last-visit") ??
      new Date(Date.now() - 86_400_000).toISOString(),
  );
  useEffect(() => {
    try {
      localStorage.setItem("bakery-last-visit", new Date().toISOString());
    } catch {
      // Without storage, "since your last visit" falls back to the last 24 hours.
    }
  }, []);
  // A snapshot of Review card IDs, walked one at a time from Today.
  const [reviewQueue, setReviewQueue] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setQuery(""), [boardId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']",
        )
      )
        return;
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutState = useRef({
    canCreate: false,
    open: (_view: RouteView) => {},
    create: () => {},
  });
  const [leaderPending, setLeaderPending] = useState(false);
  useEffect(() => {
    let pendingG = 0;
    let leaderTimer: ReturnType<typeof setTimeout> | undefined;
    const setPendingG = (on: boolean) => {
      clearTimeout(leaderTimer);
      pendingG = on ? Date.now() : 0;
      setLeaderPending(on);
      if (on) leaderTimer = setTimeout(() => setPendingG(false), 1200);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true']",
        )
      )
        return;
      const key = event.key;
      if (key === "?") {
        event.preventDefault();
        setShowShortcuts((open) => !open);
        return;
      }
      if (target?.closest("[role='dialog']")) return;
      const state = shortcutState.current;
      if (pendingG && Date.now() - pendingG < 1200) {
        setPendingG(false);
        const views = {
          t: "today",
          b: "board",
          p: "pulls",
          s: "stats",
          l: "logs",
        } as const;
        if (key in views) {
          event.preventDefault();
          state.open(views[key as keyof typeof views]);
          return;
        }
      }
      setPendingG(false);
      if (key === "g") {
        setPendingG(true);
      } else if (key === "n") {
        if (!state.canCreate) return;
        event.preventDefault();
        state.create();
      } else if ("jkhl".includes(key) && key.length === 1) {
        const tiles = Array.from(
          document.querySelectorAll<HTMLElement>("[data-card-tile]"),
        );
        if (!tiles.length) return;
        event.preventDefault();
        const current = tiles.indexOf(document.activeElement as HTMLElement);
        if (key === "j" || key === "k") {
          const step = key === "j" ? 1 : -1;
          const next =
            current < 0
              ? step > 0
                ? 0
                : tiles.length - 1
              : Math.min(tiles.length - 1, Math.max(0, current + step));
          tiles[next].focus();
          return;
        }
        const lanes: HTMLElement[][] = [];
        for (const tile of tiles) {
          const last = lanes[lanes.length - 1];
          if (last && last[0].dataset.cardTile === tile.dataset.cardTile)
            last.push(tile);
          else lanes.push([tile]);
        }
        if (current < 0) {
          tiles[0].focus();
          return;
        }
        const lane = lanes.findIndex((group) => group.includes(tiles[current]));
        const row = lanes[lane].indexOf(tiles[current]);
        const nextLane = lanes[lane + (key === "l" ? 1 : -1)];
        if (nextLane) nextLane[Math.min(row, nextLane.length - 1)].focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(leaderTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const seenStatuses = useRef(new Map<string, Map<string, CountKey>>());
  const [selected, setSelected] = useState<string | null>(null);
  // The card this tab had open before a reload; reopened once the first poll finds it.
  const restoreCard = useRef(
    initialRoute ? initialRoute.cardId : readTab("bakery-card"),
  );
  const routeReady = useRef(false);
  const firstSync = useRef(true);
  const [routeTick, setRouteTick] = useState(0);
  useEffect(() => {
    if (selected === null && restoreCard.current) return;
    writeTab("bakery-card", selected);
  }, [selected]);
  const reopenCard = (scope: Card[]) => {
    const id = restoreCard.current;
    if (!id) return;
    restoreCard.current = null;
    if (scope.some((item) => item.id === id)) setSelected(id);
    else writeTab("bakery-card", null);
  };
  const [verificationDraft, setVerificationDraft] = useState("");
  const [remoteUrlDraft, setRemoteUrlDraft] = useState("");
  const [budgetDraft, setBudgetDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflict[]>([]);
  const [busy, setBusy] = useState(false);
  // The card being dragged and the lanes it may drop on; see dropTargets.
  const [dragging, setDragging] = useState<{
    card: Card;
    targets: Status[];
  } | null>(null);
  const [dropLane, setDropLane] = useState<Status | null>(null);
  const [selectingDone, setSelectingDone] = useState(false);
  const [doneSelection, setDoneSelection] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelectingDone(false);
    setDoneSelection(new Set());
  }, [boardId]);
  const [manualCollapse, setManualCollapse] = useState<
    Record<string, Partial<Record<Status, boolean>>>
  >({});
  useEffect(() => {
    void api<Board[]>("/boards")
      .then((items) => {
        setBoards(items);
        setBoardId(
          items.find((item) => item.id === initialRoute?.boardId)?.id ??
            items.find((item) => item.id === readTab("bakery-board"))?.id ??
            items.find(
              (item) => item.id === localStorage.getItem("bakery-board"),
            )?.id ??
            items[0]?.id ??
            null,
        );
        routeReady.current = true;
        setRouteTick((n) => n + 1);
      })
      .catch((err) => setError(String(err)));
    void api<BakerySettings>("/settings")
      .then((next) => {
        document.documentElement.dataset.theme = next.theme;
        cacheTheme(next.theme);
        applyDensity(next.density);
        setSettings(next);
      })
      .catch((err) => setError(String(err)));
  }, []);
  // A new tab opens what you last looked at, so the tab you return to re-records its view and repo.
  useEffect(() => {
    const remember = () => {
      if (document.visibilityState !== "visible") return;
      try {
        localStorage.setItem("bakery-view", view);
        if (boardId) localStorage.setItem("bakery-board", boardId);
      } catch {
        // Without storage, a new tab opens Today and the first repo.
      }
    };
    remember();
    window.addEventListener("focus", remember);
    document.addEventListener("visibilitychange", remember);
    return () => {
      window.removeEventListener("focus", remember);
      document.removeEventListener("visibilitychange", remember);
    };
  }, [view, boardId]);
  useEffect(() => {
    writeTab("bakery-view", view);
    if (boardId) writeTab("bakery-board", boardId);
  }, [view, boardId]);
  // Keep the URL in step with the screen so the browser's back/forward buttons walk between screens.
  useEffect(() => {
    if (!routeReady.current) return;
    if (selected === null && restoreCard.current) return;
    const path = formatRoute({ view, boardId, cardId: selected });
    if (path === location.pathname) return;
    // The first sync only canonicalises the landing URL, so back doesn't return to it.
    if (firstSync.current) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    firstSync.current = false;
  }, [view, boardId, selected, routeTick]);
  useEffect(() => {
    const onPopState = () => {
      const route = parseRoute(location.pathname);
      if (!route) return;
      setView(route.view);
      if (route.boardId && route.boardId !== boardId) {
        if (!boards.some((item) => item.id === route.boardId)) return;
        setBoardId(route.boardId);
        setCards([]);
        setMergeConflicts([]);
        setSelected(null);
        restoreCard.current = route.cardId;
      } else {
        restoreCard.current = null;
        setSelected(route.cardId);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [boardId, boards]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((value) => value + 1);
  const openBoard = (id: string) => {
    setView("board");
    localStorage.setItem("bakery-view", "board");
    restoreCard.current = null;
    if (boardId === id) return;
    setBoardId(id);
    localStorage.setItem("bakery-board", id);
    setSelected(null);
    setCards([]);
    setMergeConflicts([]);
  };
  shortcutState.current = {
    canCreate: !!boardId && view === "board",
    open: (next) => {
      if (next === "today") openToday();
      else if (next === "stats" || next === "logs") openPage(next);
      else if (boardId)
        next === "pulls" ? openPulls(boardId) : openBoard(boardId);
    },
    create: () => setCreating(true),
  };
  const [pullHighlight, setPullHighlight] = useState<number | null>(null);
  const openPulls = (id: string, highlight: number | null = null) => {
    setPullHighlight(highlight);
    openBoard(id);
    setView("pulls");
    localStorage.setItem("bakery-view", "pulls");
  };
  const openPage = (page: "stats" | "logs") => {
    setView(page);
    localStorage.setItem("bakery-view", page);
    restoreCard.current = null;
    setSelected(null);
  };
  const openToday = () => {
    setView("today");
    localStorage.setItem("bakery-view", "today");
    restoreCard.current = null;
    setSelected(null);
  };
  // Notify once per card as it starts needing your review, comparing against the last poll of the same scope.
  // Review cards an agent, CI or GitHub still has are tracked as `reviewWaiting`, so the notice waits for them.
  const notifyNewReviews = (scope: string, next: Card[]) => {
    const previous = seenStatuses.current.get(scope);
    seenStatuses.current.set(
      scope,
      new Map(next.map((card) => [card.id, countKey(card)])),
    );
    if (
      !previous ||
      !settings?.notifyOnReview ||
      !("Notification" in window) ||
      Notification.permission !== "granted"
    )
      return;
    for (const card of next) {
      if (
        countKey(card) !== "review" ||
        !previous.has(card.id) ||
        previous.get(card.id) === "review"
      )
        continue;
      try {
        const notice = new Notification("Card ready for review", {
          body: card.title,
          tag: `review-${card.id}`,
        });
        notice.onclick = () => {
          window.focus();
          if (scope !== "today") openBoard(scope);
          setSelected(card.id);
          notice.close();
        };
      } catch {
        setError(
          "The browser could not show a Review notification. Check its notification settings.",
        );
      }
    }
  };
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (view === "today") {
          const nextBoards = await api<Board[]>("/boards");
          const [next, ...conflicts] = await Promise.all([
            api<Card[]>("/cards"),
            ...nextBoards.map((item) =>
              api<MergeConflict[]>(`/boards/${item.id}/conflicts`),
            ),
          ]);
          if (!current) return;
          notifyNewReviews("today", next as Card[]);
          setAllCards(next as Card[]);
          setMergeConflicts((conflicts as MergeConflict[][]).flat());
          setBoards(nextBoards);
          reopenCard(next as Card[]);
          return;
        }
        if (!boardId) return;
        const [next, conflicts, nextBoards] = await Promise.all([
          api<Card[]>(`/boards/${boardId}/cards`),
          api<MergeConflict[]>(`/boards/${boardId}/conflicts`),
          api<Board[]>("/boards"),
        ]);
        if (!current) return;
        notifyNewReviews(boardId, next);
        setCards(next);
        setLoadedBoard(boardId);
        setMergeConflicts(conflicts);
        setBoards(nextBoards);
        reopenCard(next);
      } catch (err) {
        if (current) setError(String(err));
      } finally {
        if (current) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [view, boardId, refreshKey, settings?.notifyOnReview]);
  // An error belongs to the board it happened on, so switching board or view dismisses it.
  useEffect(() => setError(""), [view, boardId]);
  const currentBoard = boards.find((item) => item.id === boardId);
  function editBoard(item: Board) {
    setError("");
    setRepoPath(item.repo);
    setIconDraft(item.icon);
    setColorDraft(item.color);
    setRemoteUrlDraft(item.remoteUrl ?? "");
    setVerificationDraft(item.verificationCommand ?? "");
    setEditingBoard(item);
  }
  const scopeCards = view === "today" ? allCards : cards;
  const card = scopeCards.find((item) => item.id === selected);
  // Today opens cards from any repository, so details use the card's own board.
  const detailBoardId =
    view === "today"
      ? boards.find((item) => item.repo === card?.repo)?.id
      : boardId;
  const nextInQueue = (queue: string[], after: string | null) =>
    queue
      .slice(after === null ? 0 : queue.indexOf(after) + 1)
      .find(
        (id) => allCards.find((item) => item.id === id)?.status === "review",
      ) ?? null;
  const advanceQueue = () => {
    if (!reviewQueue) return;
    const next = nextInQueue(reviewQueue, selected);
    if (!next) setReviewQueue(null);
    setSelected(next);
  };
  // A queued card that leaves Review (approved, or run again) hands over to the next one.
  useEffect(() => {
    if (reviewQueue && card && card.status !== "review") advanceQueue();
  }, [reviewQueue, card?.id, card?.status]);
  // Auto pickup is configured per repository in its edit dialog. Read the
  // polled board so start counts and pauses stay current while it is open.
  const pickupBoard = editingBoard
    ? (boards.find((item) => item.id === editingBoard.id) ?? editingBoard)
    : null;
  const savedBudget = pickupBoard?.pickupCostBudget ?? null;
  useEffect(() => {
    setBudgetDraft(savedBudget === null ? "" : String(savedBudget));
  }, [pickupBoard?.id, savedBudget]);
  const updateBoard = (updated: Board) => {
    setBoards((previous) =>
      previous.map((item) => (item.id === updated.id ? updated : item)),
    );
    setEditingBoard((editing) =>
      editing?.id === updated.id ? updated : editing,
    );
  };
  const saveSettings = (patch: Partial<BakerySettings>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    if (patch.theme) document.documentElement.dataset.theme = patch.theme;
    if (patch.density) applyDensity(patch.density);
    void action(async () => {
      try {
        const saved = await api<BakerySettings>("/settings", {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        setSettings(saved);
        document.documentElement.dataset.theme = saved.theme;
        cacheTheme(saved.theme);
        applyDensity(saved.density);
      } catch (error) {
        setSettings(previous);
        document.documentElement.dataset.theme = previous.theme;
        applyDensity(previous.density);
        throw error;
      }
    });
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      refresh();
      return true;
    } catch (err) {
      const conflict =
        err instanceof Error && "conflict" in err
          ? (err.conflict as MergeConflict | undefined)
          : undefined;
      if (conflict)
        setMergeConflicts((previous) => [
          ...previous.filter((item) => item.cardId !== conflict.cardId),
          conflict,
        ]);
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const resetPickupLimit = (target: Board) => {
    if (!target.autoPickupEnabled) return;
    if (
      !window.confirm(
        `Reset the ${target.pickupDailyLimit}-start rolling limit for ${target.repo}? This may start Ready cards immediately and spend model tokens. Earlier runs will remain in history.`,
      )
    )
      return;
    void action(async () => {
      const updated = await api<Board>(
        `/boards/${target.id}/auto-pickup/reset-limit`,
        { method: "POST" },
      );
      updateBoard(updated);
    });
  };
  // The budget is optional (blank means off). Raising or clearing a reached budget can start runs at once.
  const saveCostBudget = (event: FormEvent, target: Board) => {
    event.preventDefault();
    const text = budgetDraft.trim().replace(/^\$/, "");
    const budget = text ? Number(text) : null;
    if (
      budget !== null &&
      (!Number.isFinite(budget) || budget < 0.01 || budget > 10000)
    ) {
      setError(
        "Daily cost budget must be blank (off) or between $0.01 and $10,000",
      );
      return;
    }
    if (
      target.autoPickupEnabled &&
      target.autoPickupBudgetReached &&
      (budget === null || budget > (target.cost24h ?? 0)) &&
      !window.confirm(
        `${budget === null ? "Turn off" : "Raise"} the daily cost budget for ${target.repo}? Ready cards may start immediately and spend model tokens.`,
      )
    )
      return;
    void action(async () => {
      const updated = await api<Board>(`/boards/${target.id}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          autoPickupEnabled: target.autoPickupEnabled,
          pickupConcurrency: target.pickupConcurrency,
          pickupCostBudget: budget,
        }),
      });
      updateBoard(updated);
    });
  };
  const removeBoard = (item: Board) => {
    if (
      !window.confirm(
        `Remove the board for ${item.repo}? Cards and worktrees remain on disk. Add this repository again to restore the board.`,
      )
    )
      return;
    void action(async () => {
      await api(`/boards/${item.id}`, { method: "DELETE" });
      const remaining = boards.filter((board) => board.id !== item.id);
      setBoards(remaining);
      if (boardId === item.id) {
        const next = remaining[0]?.id ?? null;
        setBoardId(next);
        if (next) localStorage.setItem("bakery-board", next);
        else localStorage.removeItem("bakery-board");
        setSelected(null);
        setCards([]);
        setMergeConflicts([]);
      }
      setEditingBoard(null);
      setRepoPath("");
    });
  };
  const active = cards.filter((item) => item.status === "running").length;
  const needsYouCount = boards.reduce(
    (sum, item) =>
      sum +
      needsYouStatuses.reduce(
        (count, status) => count + (item.cardCounts?.[status] ?? 0),
        0,
      ),
    0,
  );
  const visibleCards = filterCards(cards, query);
  const splitReview = currentBoard?.integration === "github-pr";
  // Bulk selection only covers cards the search leaves visible.
  const doneIds = visibleCards
    .filter((item) => item.status === "done")
    .map((item) => item.id);
  // Polling can move cards out of Done; only act on cards still there.
  const selectedDone = doneIds.filter((id) => doneSelection.has(id));
  const toggleDoneSelection = (id: string) =>
    setDoneSelection((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const archiveSelected = () => {
    if (!boardId || selectedDone.length === 0) return;
    void action(async () => {
      await api(`/boards/${boardId}/cards/archive`, {
        method: "POST",
        body: JSON.stringify({ cardIds: selectedDone }),
      });
      setSelectingDone(false);
      setDoneSelection(new Set());
    });
  };
  // Each drop calls the same endpoint as the matching button in the card's details.
  const moveCard = (card: Card, to: Status) => {
    if (!boardId || !dropTargets(card).includes(to)) return;
    const path = `/boards/${boardId}/cards`;
    if (to === "running") {
      if (
        settings?.confirmRunStart &&
        !window.confirm(
          `Start Pi on "${card.title}"? This run may use paid model tokens and can edit its Git worktree.`,
        )
      )
        return;
      void action(() => api(`${path}/${card.id}/start`, { method: "POST" }));
    } else if (to === "archived" || card.status === "archived")
      void action(() =>
        api(`${path}/${to === "archived" ? "archive" : "unarchive"}`, {
          method: "POST",
          body: JSON.stringify({ cardIds: [card.id] }),
        }),
      );
    else
      void action(() =>
        api(`${path}/${card.id}/status`, {
          method: "POST",
          body: JSON.stringify({ status: to }),
        }),
      );
  };
  const endDrag = () => {
    setDragging(null);
    setDropLane(null);
  };
  const toggleLane = (status: Status, collapsed: boolean) => {
    if (!boardId) return;
    setManualCollapse((previous) => ({
      ...previous,
      [boardId]: { ...previous[boardId], [status]: !collapsed },
    }));
  };
  if (!settings && !error) return null;
  return (
    <div className="min-h-screen lg:flex">
      <UpdateNotice
        onOpenCard={(card) => {
          const target = boards.find((item) => item.repo === card.repo);
          if (target) openBoard(target.id);
          setSelected(card.id);
        }}
      />
      {sidebarHidden && (
        <button
          aria-label="Show sidebar"
          title="Show sidebar"
          onClick={toggleSidebar}
          className="fixed left-3 top-3 z-30 hidden rounded-md border border-border bg-sidebar p-1.5 text-muted-foreground hover:text-foreground lg:block"
        >
          <PanelLeftOpen size={15} />
        </button>
      )}
      <aside
        hidden={sidebarHidden}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
        className="relative flex flex-col border-b border-border bg-sidebar lg:sticky lg:top-0 lg:h-screen lg:w-[var(--sidebar-w)] lg:shrink-0 lg:border-r lg:border-b-0"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={startSidebarResize}
          onDoubleClick={() => {
            setSidebarWidth(228);
            localStorage.setItem("bakery-sidebar-width", "228");
          }}
          className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize hover:bg-primary/30 lg:block"
        />
        <div className="flex items-center gap-3 px-6 py-7">
          <BrandIcon />
          <span className="text-[18px] font-semibold tracking-[-.04em]">
            bakery<span className="text-primary">.</span>
          </span>
          <button
            aria-label="Hide sidebar"
            title="Hide sidebar"
            onClick={toggleSidebar}
            className="ml-auto hidden p-1 text-muted-foreground hover:text-foreground lg:block"
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
        <div className="px-4 pt-5">
          <button
            onClick={openToday}
            className={`mb-5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[length:var(--text-sidebar)] ${view === "today" ? "bg-accent/50" : "hover:bg-accent/30"}`}
          >
            <Sun size={16} aria-hidden="true" className="text-primary" />
            Today
            {needsYouCount > 0 && (
              <span className="ml-auto rounded-full bg-primary/15 px-2 font-mono text-[length:var(--text-sidebar-meta)] text-primary">
                {needsYouCount}
              </span>
            )}
          </button>
          <button
            onClick={toggleRepos}
            aria-expanded={!reposCollapsed}
            aria-controls="sidebar-repositories"
            className="mb-3 flex w-full items-center gap-1 rounded px-3 text-left text-[length:calc(0.625rem*var(--density-text))] font-normal uppercase tracking-[.16em] text-muted-foreground hover:text-foreground"
          >
            Repositories
            {reposCollapsed ? (
              <ChevronRight size={12} aria-hidden="true" className="ml-auto" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" className="ml-auto" />
            )}
          </button>
          <div id="sidebar-repositories" hidden={reposCollapsed}>
            {boards.map((item) => {
              const active = view === "board" && boardId === item.id;
              const pullsActive = view === "pulls" && boardId === item.id;
              const open = repoOpen[item.id] ?? (active || pullsActive);
              return (
                <div key={item.id} className="rounded-lg">
                  <div className="flex items-center rounded-lg hover:bg-accent/30">
                    <button
                      onClick={() => {
                        toggleRepoOpen(item.id, open);
                        if (!open) openBoard(item.id);
                      }}
                      aria-expanded={open}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-[length:var(--text-sidebar)]"
                      title={item.repo}
                    >
                      <RepoBadge board={item} />
                      <span className="truncate">{repoName(item.repo)}</span>
                    </button>
                    <ul
                      aria-label="Card counts"
                      className="flex shrink-0 items-center justify-end gap-2 pr-3"
                    >
                      {sidebarCounts.map((group) => {
                        const Icon = group.icon;
                        const live =
                          view === "board" &&
                          boardId === item.id &&
                          (cards.length || !item.cardCounts);
                        const count = group.statuses.reduce(
                          (sum, status) =>
                            sum +
                            (live
                              ? cards.filter((c) => countKey(c) === status)
                                  .length
                              : (item.cardCounts?.[status] ?? 0)),
                          0,
                        );
                        if (group.hideEmpty && !count) return null;
                        return (
                          <li
                            key={group.id}
                            data-group={group.id}
                            data-status={group.color}
                            title={`${count} ${group.label.toLowerCase()}`}
                            aria-label={`${group.label}: ${count}`}
                            className={`flex items-center gap-1 text-[length:var(--text-sidebar-meta)] ${count ? "" : "opacity-40"}`}
                          >
                            <Icon
                              size={10}
                              aria-hidden="true"
                              className="lane-status-icon shrink-0"
                            />
                            <span className="font-mono">{count}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {open && (
                    <button
                      onClick={() => openBoard(item.id)}
                      aria-current={active ? "page" : undefined}
                      className={`ml-8 mt-0.5 flex w-[calc(100%-2rem)] items-center gap-2 rounded-md px-3 py-1.5 text-left text-[length:var(--text-sidebar)] ${active ? "bg-accent/50" : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"}`}
                    >
                      <Kanban size={13} aria-hidden="true" /> Kanban
                    </button>
                  )}
                  {open && supportsPullRequests(item) && (
                    <button
                      onClick={() => openPulls(item.id)}
                      aria-current={pullsActive ? "page" : undefined}
                      className={`ml-8 mt-0.5 flex w-[calc(100%-2rem)] items-center gap-2 rounded-md px-3 py-1.5 text-left text-[length:var(--text-sidebar)] ${pullsActive ? "bg-accent/50" : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"}`}
                    >
                      <GitPullRequest size={13} aria-hidden="true" /> Pull
                      requests
                    </button>
                  )}
                </div>
              );
            })}
            <Button
              variant="ghost"
              className="mt-2 w-full justify-start text-[length:var(--text-sidebar)]"
              onClick={() => {
                setError("");
                setAddingRepo(true);
              }}
            >
              <Plus size={15} /> Add repository
            </Button>
          </div>
          <button
            onClick={() => openPage("stats")}
            aria-current={view === "stats" ? "page" : undefined}
            className={`mt-5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[length:var(--text-sidebar)] ${view === "stats" ? "bg-accent/50" : "hover:bg-accent/30"}`}
          >
            <BarChart3 size={16} aria-hidden="true" className="text-primary" />
            Statistics
          </button>
          <button
            onClick={() => openPage("logs")}
            aria-current={view === "logs" ? "page" : undefined}
            className={`mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[length:var(--text-sidebar)] ${view === "logs" ? "bg-accent/50" : "hover:bg-accent/30"}`}
          >
            <ScrollText size={16} aria-hidden="true" className="text-primary" />
            Logs
          </button>
          <Button
            variant="ghost"
            className="mt-2 w-full justify-start text-[length:var(--text-sidebar)]"
            onClick={() => {
              setError("");
              setShowSettings(true);
            }}
          >
            <Settings2 size={15} /> Settings
          </Button>
        </div>
        <div className="mt-auto hidden border-t border-border px-6 py-5 lg:block">
          <div className="flex items-center gap-2 text-[length:var(--text-sidebar-meta)] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-status-review" />{" "}
            <ServerHost /> <span className="ml-auto font-mono">v0.1</span>
          </div>
        </div>
      </aside>
      {view === "today" && (
        <main className="min-w-0 flex-1">
          <Today
            boards={boards}
            cards={allCards}
            since={since}
            onOpen={(item) => setSelected(item.id)}
            onReview={() => {
              const queue = reviewOrder(allCards).map((item) => item.id);
              setReviewQueue(queue);
              setSelected(queue[0] ?? null);
            }}
            onCapture={(board, title) =>
              action(() =>
                api(`/boards/${board.id}/cards`, {
                  method: "POST",
                  body: JSON.stringify({ title, body: "" }),
                }),
              )
            }
          />
        </main>
      )}
      {view === "stats" && (
        <main className="min-w-0 flex-1">
          <Statistics boards={boards} />
        </main>
      )}
      {view === "logs" && (
        <main className="min-w-0 flex-1">
          <Logs />
        </main>
      )}
      {view === "pulls" &&
        boardId &&
        currentBoard &&
        supportsPullRequests(currentBoard) && (
          <main className="min-w-0 flex-1">
            <header className="border-b border-border px-6 py-6 lg:px-10">
              <h1 className="text-[27px] font-semibold tracking-[-.05em]">
                Pull requests
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {currentBoard?.repo}
              </p>
            </header>
            <PullRequests
              boardId={boardId}
              highlight={pullHighlight}
              onOpenCard={(id) => {
                openBoard(boardId);
                setSelected(id);
              }}
            />
          </main>
        )}
      <main
        className="min-w-0 flex-1"
        hidden={
          view === "today" ||
          view === "stats" ||
          view === "logs" ||
          (view === "pulls" &&
            !!currentBoard &&
            supportsPullRequests(currentBoard))
        }
      >
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10">
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[.18em] text-muted-foreground">
              Workspace / Board
            </div>
            <h1 className="flex items-center gap-3 text-[27px] font-semibold tracking-[-.05em]">
              {currentBoard && <RepoBadge board={currentBoard} />}
              {currentBoard
                ? repoName(currentBoard.repo)
                : "Choose a repository"}
              {currentBoard && (
                <button
                  aria-label={`Edit ${currentBoard.repo}`}
                  title="Edit repository"
                  className="p-1 text-muted-foreground hover:text-foreground"
                  onClick={() => editBoard(currentBoard)}
                >
                  <Pencil size={15} />
                </button>
              )}
            </h1>
            {!currentBoard && (
              <p className="mt-1 text-sm text-muted-foreground">
                Add a Git repository to create its board.
              </p>
            )}
            {currentBoard?.remoteUrl && (
              <RemoteLink url={currentBoard.remoteUrl} />
            )}
            {currentBoard && (
              <p
                data-testid="integration-mode"
                className="mt-1 text-xs text-muted-foreground"
              >
                {currentBoard.integration === "github-pr"
                  ? "Integration: GitHub pull requests. Approve opens a PR; Done once it merges"
                  : "Integration: local main. Approve merges into local main; Bakery does not push"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <div className="relative">
                <Search
                  size={14}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Search cards"
                  placeholder="Search cards  /"
                  disabled={!boardId}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    if (query) setQuery("");
                    else event.currentTarget.blur();
                  }}
                  className="h-9 w-56 rounded-md border border-input bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {query.trim() && (
                <span
                  role="status"
                  aria-label="Search results"
                  className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-muted-foreground"
                >
                  {visibleCards.length} of {cards.length} cards
                </span>
              )}
            </div>
            <Button disabled={!boardId} onClick={() => setCreating(true)}>
              <Plus size={16} /> New card
            </Button>
          </div>
        </header>
        <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border px-6 py-4 text-xs text-muted-foreground lg:px-10">
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {loadedBoard === boardId
                ? cards.filter((c) => c.status !== "archived").length
                : "…"}
            </strong>{" "}
            cards
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.filter((c) => c.status === "triage").length}
            </strong>{" "}
            in triage
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.filter((c) => c.status === "ready").length}
            </strong>{" "}
            ready
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">{active}</strong>{" "}
            running
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.filter(needsYourReview).length}
            </strong>{" "}
            awaiting review
          </span>
          <label className="ml-auto flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              disabled={!currentBoard || busy}
              checked={currentBoard?.autoCollapseEmptySwimlanes ?? false}
              onChange={(event) => {
                const enabled = event.target.checked;
                if (!boardId) return;
                void action(async () => {
                  const updated = await api<Board>(
                    `/boards/${boardId}/settings`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        autoCollapseEmptySwimlanes: enabled,
                      }),
                    },
                  );
                  setBoards((previous) =>
                    previous.map((item) =>
                      item.id === updated.id ? updated : item,
                    ),
                  );
                  setManualCollapse((previous) => ({
                    ...previous,
                    [updated.id]: {},
                  }));
                });
              }}
              className="accent-primary"
            />{" "}
            Auto-collapse lanes without active cards
          </label>
          {currentBoard?.autoPickupEnabled && (
            <span className="text-primary">
              Auto pickup · {currentBoard.pickupConcurrency} at a time
            </span>
          )}
          {currentBoard && (
            <span
              title="Model cost of attempts and agent reviews running or finished in the last 24 hours"
              className={
                currentBoard.autoPickupBudgetReached ? "text-amber-600" : ""
              }
            >
              Last 24h: {formatCost(currentBoard.cost24h ?? 0)}
              {typeof currentBoard.pickupCostBudget === "number" &&
                ` of ${formatCost(currentBoard.pickupCostBudget)} budget`}
            </span>
          )}
          <span className="hidden items-center gap-1.5 lg:flex">
            <CircleHelp size={13} /> Starting a run may use paid model tokens
          </span>
        </div>
        {currentBoard?.autoPickupEnabled &&
          currentBoard.pickupDailyLimit > 0 &&
          currentBoard.autoPickupStarts >= currentBoard.pickupDailyLimit && (
            <div
              role="alert"
              className="mx-6 mt-5 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm lg:mx-10"
            >
              <strong>
                Auto pickup waiting: {currentBoard.autoPickupStarts} /{" "}
                {currentBoard.pickupDailyLimit} automatic starts in the last 24
                hours.
              </strong>{" "}
              {currentBoard.autoPickupNextAt && (
                <>Next slot around {date(currentBoard.autoPickupNextAt)}.</>
              )}
              <button
                className="ml-3 underline underline-offset-2"
                disabled={busy}
                onClick={() => currentBoard && resetPickupLimit(currentBoard)}
              >
                Reset start limit
              </button>
            </div>
          )}
        {currentBoard?.autoPickupEnabled &&
          currentBoard.autoPickupBudgetReached && (
            <div
              role="alert"
              className="mx-6 mt-5 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm lg:mx-10"
            >
              <strong>
                Auto pickup waiting: daily cost budget reached (
                {formatCost(currentBoard.cost24h ?? 0)} of{" "}
                {formatCost(currentBoard.pickupCostBudget)} in the last 24
                hours).
              </strong>{" "}
              Pickup resumes as older spend leaves the 24-hour window, or raise
              the budget in this repository's settings. Manual starts still
              work.
            </div>
          )}
        {currentBoard?.autoPickupError && (
          <div
            role="alert"
            className="mx-6 mt-5 flex items-center justify-between gap-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive lg:mx-10"
          >
            <span>Auto pickup paused: {currentBoard.autoPickupError}.</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                const target = currentBoard;
                void action(async () => {
                  const updated = await api<Board>(
                    `/boards/${target.id}/settings`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        autoPickupEnabled: true,
                        pickupConcurrency: target.pickupConcurrency,
                      }),
                    },
                  );
                  updateBoard(updated);
                });
              }}
            >
              Resume auto pickup
            </Button>
          </div>
        )}
        {currentBoard?.integration === "github-pr" &&
          (currentBoard.integrationError ||
            currentBoard.integrationWarning) && (
            <div
              role="alert"
              className={`mx-6 mt-5 flex items-center justify-between gap-4 rounded-md border px-4 py-3 text-sm lg:mx-10 ${currentBoard.integrationError ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-amber-500/40 bg-amber-500/10"}`}
            >
              <span className="min-w-0 break-words">
                <strong>
                  {currentBoard.integrationError
                    ? "GitHub sync stopped and auto pickup is waiting:"
                    : "Can't reach GitHub right now; retrying every minute:"}
                </strong>{" "}
                {currentBoard.integrationError ||
                  currentBoard.integrationWarning}
                {currentBoard.integrationSyncedAt && (
                  <> Last synced {date(currentBoard.integrationSyncedAt)}.</>
                )}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const target = currentBoard;
                  void action(async () => {
                    updateBoard(
                      await api<Board>(`/boards/${target.id}/sync`, {
                        method: "POST",
                      }),
                    );
                  });
                }}
              >
                Retry now
              </Button>
            </div>
          )}
        {error && (
          <div
            role="alert"
            className="fixed bottom-6 right-6 z-50 flex max-w-md items-start gap-3 rounded-md border border-destructive/30 bg-background px-4 py-3 text-sm text-destructive shadow-lg"
          >
            <XCircle size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 break-words">
              <strong className="block">Action failed</strong>
              {error}
            </div>
            <button
              className="ml-auto"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {!selected && mergeConflicts.length > 0 && (
          <div
            role="alert"
            className="mx-6 mt-5 flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm lg:mx-10"
          >
            <XCircle size={16} className="text-destructive" />
            <span>
              {mergeConflicts.length}{" "}
              {mergeConflicts.length === 1 ? "card has" : "cards have"} merge
              conflicts. The card worktrees are still available.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(mergeConflicts[0].cardId)}
            >
              View conflicts
            </Button>
          </div>
        )}
        {boardId && loadedBoard !== boardId && (
          <p
            role="status"
            className="px-6 pt-6 text-sm text-muted-foreground lg:px-10"
          >
            Loading cards…
          </p>
        )}
        <div
          className={`overflow-x-auto p-6 lg:p-10 ${boardId && loadedBoard !== boardId ? "hidden" : ""}`}
        >
          <div className="flex min-h-[500px] min-w-max gap-4">
            {(splitReview ? pullRequestLanes : columns).map((column) => {
              const sorted = byPriority(
                visibleCards.filter(
                  (c) => laneOf(c, splitReview) === column.id,
                ),
              );
              // Review splits into cards that need you, then cards an agent, CI or GitHub still has.
              const waitingCards = sorted.filter((c) => c.reviewWait);
              const laneCards =
                column.id === "review" && !splitReview
                  ? [...sorted.filter((c) => !c.reviewWait), ...waitingCards]
                  : sorted;
              const firstWaiting =
                column.id === "review" && !splitReview
                  ? waitingCards[0]?.id
                  : undefined;
              const yourTurnCount = laneCards.filter(needsYourReview).length;
              const firstYourTurn = splitReview
                ? undefined
                : laneCards.find(needsYourReview)?.id;
              // Collapse state follows the whole lane so typing a search
              // doesn't fold or unfold lanes.
              const collapsible = cards
                .filter((c) => laneOf(c, splitReview) === column.id)
                .every((c) => c.status === "done" || c.status === "archived");
              const override = boardId
                ? manualCollapse[boardId]?.[column.status]
                : undefined;
              const collapsed =
                collapsible &&
                (override ??
                  (column.id === "archived" ||
                    (currentBoard?.autoCollapseEmptySwimlanes ?? false)));
              const selecting =
                column.id === "done" && selectingDone && laneCards.length > 0;
              const droppable =
                !!dragging?.targets.includes(column.status) &&
                column.id === column.status;
              return (
                <section
                  key={column.id}
                  aria-label={`${column.label} lane`}
                  data-status={column.status}
                  data-drop={
                    dragging
                      ? droppable
                        ? dropLane === column.id
                          ? "over"
                          : "valid"
                        : "invalid"
                      : undefined
                  }
                  onDragOver={(event) => {
                    if (!droppable) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dropLane !== column.status) setDropLane(column.status);
                  }}
                  onDragLeave={(event) => {
                    if (
                      dropLane === column.status &&
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    )
                      setDropLane(null);
                  }}
                  onDrop={(event) => {
                    if (!dragging || !droppable) return;
                    event.preventDefault();
                    const { card } = dragging;
                    endDrag();
                    moveCard(card, column.status);
                  }}
                  className={`${collapsed ? "flex w-12" : "w-[280px]"} lane-drop shrink-0 rounded-xl transition-opacity`}
                >
                  {collapsed ? (
                    <button
                      type="button"
                      aria-label={`Expand ${column.label} lane`}
                      aria-expanded={false}
                      onClick={() => toggleLane(column.status, true)}
                      className="flex min-h-48 w-full flex-col items-center gap-3 rounded-lg border border-border bg-card px-2 py-3 text-sm hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronRight size={16} />
                      <span
                        aria-hidden="true"
                        className="lane-status-dot size-2.5 shrink-0 rounded-full"
                      />
                      <span className="[writing-mode:vertical-rl]">
                        {column.label}
                      </span>
                      <span className="rounded bg-secondary px-1 font-mono text-xs text-muted-foreground">
                        {laneCards.length}
                      </span>
                    </button>
                  ) : (
                    <>
                      <div
                        className={`mb-2 flex min-h-6 items-center gap-2 px-1 ${collapsible ? "cursor-pointer" : ""}`}
                        onClick={(event) => {
                          if (
                            collapsible &&
                            !(event.target as HTMLElement).closest("button")
                          )
                            toggleLane(column.status, false);
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="lane-status-dot size-2.5 shrink-0 rounded-full"
                        />
                        <h2 className="text-sm font-semibold">
                          {column.label}
                        </h2>
                        <span className="ml-auto rounded-md bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
                          {laneCards.length}
                        </span>
                        {column.id === "done" &&
                          laneCards.length > 0 &&
                          !selecting && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectingDone(true);
                                setDoneSelection(new Set());
                              }}
                              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Select
                            </button>
                          )}
                        {collapsible && (
                          <button
                            type="button"
                            aria-label={`Collapse ${column.label} lane`}
                            aria-expanded={true}
                            onClick={() => toggleLane(column.status, false)}
                            className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ChevronDown size={16} />
                          </button>
                        )}
                      </div>
                      {selecting && (
                        <div
                          role="toolbar"
                          aria-label="Done card selection"
                          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
                        >
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="accent-primary"
                              checked={selectedDone.length === doneIds.length}
                              ref={(element) => {
                                if (element)
                                  element.indeterminate =
                                    selectedDone.length > 0 &&
                                    selectedDone.length < doneIds.length;
                              }}
                              onChange={(event) =>
                                setDoneSelection(
                                  new Set(event.target.checked ? doneIds : []),
                                )
                              }
                            />
                            Select all
                          </label>
                          <span className="text-muted-foreground">
                            {selectedDone.length} selected
                          </span>
                          <div className="ml-auto flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => {
                                setSelectingDone(false);
                                setDoneSelection(new Set());
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy || selectedDone.length === 0}
                              onClick={archiveSelected}
                            >
                              Archive
                            </Button>
                          </div>
                        </div>
                      )}
                      <div className="space-y-3">
                        {laneCards.map((item) => {
                          const activity = cardActivity(item);
                          const content = (
                            <>
                              <div className="flex items-start justify-between gap-2 empty:hidden [&:has(>span:empty)]:hidden mb-4">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  {(item.priority ?? 0) !== 0 && (
                                    <PriorityBadge priority={item.priority} />
                                  )}
                                  {item.blocked && (
                                    <WaitingBadge
                                      waiting={waitingOn(item, cards)}
                                    />
                                  )}
                                  {item.prNumber && (
                                    <PullRequestBadge
                                      card={item}
                                      onOpen={
                                        currentBoard &&
                                        supportsPullRequests(currentBoard) &&
                                        item.prState === "OPEN"
                                          ? () =>
                                              openPulls(
                                                currentBoard.id,
                                                item.prNumber ?? null,
                                              )
                                          : undefined
                                      }
                                    />
                                  )}
                                  {item.status === "done" &&
                                    item.originMain && (
                                      <OriginMainBadge
                                        state={item.originMain}
                                      />
                                    )}
                                  <ActivityBadge
                                    card={item}
                                    activity={activity}
                                  />
                                  {item.attempts > 1 && (
                                    <span
                                      data-testid="attempt-count"
                                      title={reworkSummary(item)}
                                      className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-500"
                                    >
                                      <RotateCcw size={10} aria-hidden />
                                      {item.attempts} attempts
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div className="text-[14px] font-medium leading-snug text-foreground">
                                {item.title}
                              </div>
                              <p className="mt-2 line-clamp-2 min-h-9 text-xs leading-relaxed text-muted-foreground">
                                {markdownToPlainText(item.body) ||
                                  "No description yet."}
                              </p>
                              {(item.runAgent ||
                                item.reviewAgent ||
                                item.planOnly) && (
                                <div className="mt-3 flex flex-wrap gap-1">
                                  {item.planOnly && (
                                    <span
                                      className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                                      title="This run produced a plan, not code"
                                    >
                                      Plan
                                    </span>
                                  )}
                                  {item.runAgent && (
                                    <AgentBadge
                                      phase="Run"
                                      agent={item.runAgent}
                                    />
                                  )}
                                  {item.reviewAgent && (
                                    <AgentBadge
                                      phase="Review"
                                      agent={item.reviewAgent}
                                    />
                                  )}
                                </div>
                              )}
                              <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] text-muted-foreground">
                                <span className="flex min-w-0 items-center gap-1 truncate">
                                  <GitBranch size={11} className="shrink-0" />{" "}
                                  {repoName(item.repo)}
                                </span>
                                <span
                                  className="flex items-center gap-1"
                                  title={
                                    item.turnsIncomplete
                                      ? "Estimated from older transcripts; may be inaccurate. New turns are counted exactly."
                                      : "Completed Pi turns across all attempts"
                                  }
                                >
                                  <Clock3 size={11} />{" "}
                                  {item.turnsIncomplete
                                    ? item.turns
                                      ? `~${item.turns}`
                                      : "?"
                                    : item.turns}
                                </span>
                                <span>{date(item.createdAt)}</span>
                              </div>
                            </>
                          );
                          const cardClass =
                            "group block w-full rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
                          if (selecting) {
                            const checked = doneSelection.has(item.id);
                            return (
                              <label
                                key={item.id}
                                className={`${cardClass} relative cursor-pointer focus-within:ring-2 focus-within:ring-ring ${checked ? "border-primary/60" : "border-border/80"}`}
                              >
                                <input
                                  type="checkbox"
                                  className="absolute top-4 right-4 size-4 accent-primary"
                                  aria-label={`Select ${item.title}`}
                                  checked={checked}
                                  onChange={() => toggleDoneSelection(item.id)}
                                />
                                {content}
                              </label>
                            );
                          }
                          const targets = dropTargets(item);
                          const tile = (
                            <button
                              key={item.id}
                              onClick={() => {
                                setSelected(item.id);
                              }}
                              draggable={!busy && targets.length > 0}
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(
                                  "text/plain",
                                  item.id,
                                );
                                setDragging({ card: item, targets });
                              }}
                              onDragEnd={endDrag}
                              data-card-tile={item.status}
                              data-activity={activity ?? undefined}
                              data-turn={
                                needsYourReview(item) ? "yours" : undefined
                              }
                              data-dragging={
                                dragging?.card.id === item.id || undefined
                              }
                              className={`${cardClass} card-activity border-border/80 ${targets.length > 0 ? "cursor-grab active:cursor-grabbing" : ""} data-[dragging]:opacity-50`}
                            >
                              {content}
                            </button>
                          );
                          if (item.id === firstYourTurn)
                            return (
                              <Fragment key={item.id}>
                                <div
                                  role="separator"
                                  aria-label="Your turn"
                                  className="flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-[.14em] text-foreground"
                                >
                                  Your turn
                                  <span className="h-px flex-1 bg-status-review" />
                                  <span className="font-mono">
                                    {yourTurnCount}
                                  </span>
                                </div>
                                {tile}
                              </Fragment>
                            );
                          if (item.id !== firstWaiting) return tile;
                          return (
                            <Fragment key={item.id}>
                              <div
                                role="separator"
                                aria-label="Not your turn yet"
                                className="flex items-center gap-2 px-1 pt-2 text-[10px] font-semibold uppercase tracking-[.14em] text-muted-foreground"
                              >
                                Not your turn yet
                                <span className="h-px flex-1 bg-border" />
                                <span className="font-mono">
                                  {waitingCards.length}
                                </span>
                              </div>
                              {tile}
                            </Fragment>
                          );
                        })}
                        {laneCards.length === 0 && (
                          <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-xs text-muted-foreground">
                            {query.trim()
                              ? "No matching cards."
                              : "Nothing here yet."}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </main>
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            These preferences are saved in Bakery's local database.
          </DialogDescription>
          <label className="mt-6 flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={settings?.confirmRunStart ?? false}
              disabled={!settings || busy}
              onChange={(event) =>
                saveSettings({ confirmRunStart: event.target.checked })
              }
            />
            <span>
              Confirm before starting a run
              <span className="mt-1 block text-xs text-muted-foreground">
                When off, Start Pi run launches immediately and may use paid
                model tokens.
              </span>
            </span>
          </label>
          <label className="mt-6 flex items-start gap-3 border-t border-border pt-5 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={settings?.notifyOnReview ?? false}
              disabled={!settings || busy || !("Notification" in window)}
              onChange={async (event) => {
                if (!event.target.checked) {
                  saveSettings({ notifyOnReview: false });
                  return;
                }
                try {
                  const permission = await Notification.requestPermission();
                  if (permission === "granted")
                    saveSettings({ notifyOnReview: true });
                  else
                    setError(
                      "Browser notification permission was not granted. Allow notifications for Bakery in your browser to enable them.",
                    );
                } catch {
                  setError(
                    "The browser could not request notification permission.",
                  );
                }
              }}
            />
            <span>
              Notify when a card enters Review
              <span className="mt-1 block text-xs text-muted-foreground">
                Browser notifications appear while this board page is open. Your
                browser must allow notifications. Cards already in Review when
                you open the page do not trigger one.
              </span>
            </span>
          </label>
          <fieldset
            className="mt-6 border-t border-border pt-5 text-sm"
            disabled={!settings || busy}
          >
            <legend className="pt-5 font-medium">Theme</legend>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              {themeNames.map((theme) => (
                <label
                  key={theme}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="radio"
                    name="theme"
                    checked={(settings?.theme ?? "default") === theme}
                    onChange={() => saveSettings({ theme })}
                    className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                  {themes[theme].label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset
            className="mt-6 border-t border-border pt-5 text-sm"
            disabled={!settings || busy}
          >
            <legend className="pt-5 font-medium">Density</legend>
            <div className="mt-3 flex gap-5">
              {(["compact", "default", "cozy"] as const).map((density) => (
                <label
                  key={density}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="radio"
                    name="density"
                    checked={(settings?.density ?? "default") === density}
                    onChange={() => saveSettings({ density })}
                    className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                  {density === "compact"
                    ? "Compact"
                    : density === "cozy"
                      ? "Cozy"
                      : "Default"}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset
            className="mt-6 border-t border-border pt-5 text-sm"
            disabled={!settings || busy}
          >
            <legend className="pt-5 font-medium">Card details layout</legend>
            <div className="mt-3 flex gap-5">
              {(["dialog", "side"] as const).map((layout) => (
                <label
                  key={layout}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="radio"
                    name="card-details-layout"
                    checked={settings?.cardDetailsLayout === layout}
                    onChange={() => saveSettings({ cardDetailsLayout: layout })}
                    className="accent-primary"
                  />
                  {layout === "dialog" ? "Popup" : "Side panel"}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The side panel stays wide for review. On small screens it opens
              full-screen.
            </p>
          </fieldset>
          <div className="mt-6 border-t border-border pt-5 text-sm">
            <div className="font-medium">Pi models</div>
            <p className="mt-2 text-xs text-muted-foreground">
              Model and thinking level for each kind of Pi run. Blank fields use
              Pi's own default. A repository can override these in its edit
              dialog.
            </p>
            {settings && (
              <AgentModelFields
                key={JSON.stringify(settings.agentModels)}
                scope="global"
                value={settings.agentModels ?? emptyAgentModels()}
                disabled={busy}
                onSave={(agentModels) => saveSettings({ agentModels })}
              />
            )}
          </div>
          <p className="mt-6 border-t border-border pt-5 text-xs text-muted-foreground">
            Auto pickup is set per repository. Use the edit button next to a
            repository to change it.
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={addingRepo || !!editingBoard}
        onOpenChange={(open) => {
          if (!open) {
            setAddingRepo(false);
            setEditingBoard(null);
            setRepoPath("");
          }
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            if (!editingBoard) return;
            event.preventDefault();
            (event.target as HTMLElement | null)?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (
              document.activeElement?.getAttribute("aria-expanded") === "true"
            )
              event.preventDefault();
          }}
        >
          <DialogTitle>
            {editingBoard ? "Edit repository" : "Add repository"}
          </DialogTitle>
          <DialogDescription>
            {editingBoard
              ? "Cards can move to a different root only before their first run."
              : "Enter an existing Git repository root. Paths starting with ~/ are supported."}
          </DialogDescription>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {repoCheck?.path === repoPath && repoCheck.error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {repoCheck.error}
            </p>
          )}
          <form
            className="mt-5 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void action(async () => {
                let item = await api<Board>(
                  editingBoard ? `/boards/${editingBoard.id}` : "/boards",
                  {
                    method: editingBoard ? "PATCH" : "POST",
                    body: JSON.stringify({ repo: repoPath }),
                  },
                );
                if (
                  editingBoard &&
                  (iconDraft !== editingBoard.icon ||
                    colorDraft !== editingBoard.color)
                ) {
                  item = await api<Board>(`/boards/${item.id}/settings`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      icon: iconDraft,
                      color: colorDraft,
                    }),
                  });
                }
                setBoards((previous) =>
                  [
                    ...previous.filter((board) => board.id !== item.id),
                    item,
                  ].sort((a, b) => a.repo.localeCompare(b.repo)),
                );
                openBoard(item.id);
                setRepoPath("");
                setAddingRepo(false);
                setEditingBoard(null);
              });
            }}
          >
            <RepositoryPathInput value={repoPath} onChange={setRepoPath} />
            <Button
              disabled={
                busy || repoCheck?.path !== repoPath || !!repoCheck.error
              }
              type="submit"
            >
              {editingBoard ? "Save repository" : "Add"}
            </Button>
          </form>
          {editingBoard && (
            <div className="mt-8 border-t border-border pt-5">
              <div className="text-sm font-medium">Appearance</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose an icon and color for this repository.
              </p>
              <div
                className="mt-4 grid grid-cols-8 gap-2"
                role="group"
                aria-label="Repository icon"
              >
                {repoIcons.map((name) => {
                  // Each tile previews the icon on the chosen color's badge background.
                  const color = repoColorVar(colorDraft);
                  return (
                    <button
                      key={name}
                      type="button"
                      title={name.replaceAll("_", " ")}
                      aria-label={`Icon: ${name.replaceAll("_", " ")}`}
                      aria-pressed={iconDraft === name}
                      onClick={() => setIconDraft(name)}
                      style={{
                        backgroundColor: repoTint(color),
                        borderColor: iconDraft === name ? color : "transparent",
                        boxShadow:
                          iconDraft === name ? `0 0 0 1px ${color}` : undefined,
                      }}
                      className={`grid size-9 place-items-center rounded-md border cursor-pointer ${iconDraft === name ? "" : "opacity-70 hover:opacity-100"}`}
                    >
                      <img
                        src={`/icons/${name}.png`}
                        width={20}
                        height={20}
                        alt=""
                        className="object-contain"
                      />
                    </button>
                  );
                })}
              </div>
              <div
                className="mt-5 flex flex-wrap gap-2"
                role="group"
                aria-label="Repository color"
              >
                {(Object.entries(repoColors) as [RepoColor, string][]).map(
                  ([name, hex]) => (
                    <button
                      key={name}
                      type="button"
                      title={name}
                      aria-label={`Color: ${name}`}
                      aria-pressed={colorDraft === name}
                      onClick={() => setColorDraft(name)}
                      className={`size-8 rounded-full border-2 cursor-pointer ${colorDraft === name ? "border-foreground" : "border-transparent"}`}
                    >
                      <span
                        className="block size-full rounded-full border-2 border-background"
                        style={{
                          backgroundColor: `var(--repo-${name}, ${hex})`,
                        }}
                      />
                    </button>
                  ),
                )}
              </div>
              <Button
                className="mt-5"
                disabled={
                  busy ||
                  (iconDraft === editingBoard.icon &&
                    colorDraft === editingBoard.color)
                }
                onClick={() =>
                  void action(async () => {
                    const updated = await api<Board>(
                      `/boards/${editingBoard.id}/settings`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({
                          icon: iconDraft,
                          color: colorDraft,
                        }),
                      },
                    );
                    setBoards((previous) =>
                      previous.map((item) =>
                        item.id === updated.id ? updated : item,
                      ),
                    );
                    setEditingBoard(updated);
                  })
                }
              >
                Save appearance
              </Button>
            </div>
          )}
          {editingBoard && (
            <form
              className="mt-8 border-t border-border pt-5"
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const updated = await api<Board>(
                    `/boards/${editingBoard.id}/settings`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({ remoteUrl: remoteUrlDraft }),
                    },
                  );
                  setBoards((previous) =>
                    previous.map((item) =>
                      item.id === updated.id ? updated : item,
                    ),
                  );
                  setEditingBoard(updated);
                  setRemoteUrlDraft(updated.remoteUrl ?? "");
                });
              }}
            >
              <div className="text-sm font-medium">Remote repository</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional link to the remote this repository tracks, such as its
                GitHub page. It appears below the board heading. Bakery never
                pushes to it.
              </p>
              <div className="mt-4 flex gap-2">
                <input
                  type="url"
                  aria-label="Remote repository link"
                  value={remoteUrlDraft}
                  onChange={(event) => setRemoteUrlDraft(event.target.value)}
                  disabled={busy}
                  placeholder="https://github.com/owner/repo"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    busy ||
                    remoteUrlDraft.trim() === (editingBoard.remoteUrl ?? "")
                  }
                >
                  {remoteUrlDraft.trim() || !editingBoard.remoteUrl
                    ? "Save link"
                    : "Remove link"}
                </Button>
              </div>
            </form>
          )}
          {editingBoard && (
            <div className="mt-8 border-t border-border pt-5 text-sm">
              <div className="font-medium">Integration</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Local: Approve merges the card into local main. GitHub pull
                requests: Approve pushes bakery/&lt;card&gt; and opens a PR with
                gh; the card is Done once the PR merges and the merge is on
                origin/main. Local main is then only fast-forwarded to
                origin/main. Needs gh signed in and a GitHub remote link. When a
                GitHub remote is set, Bakery picks GitHub pull requests if main
                only accepts pull requests.
              </p>
              <label className="mt-4 block text-xs">
                Integration mode
                <select
                  aria-label="Integration mode"
                  value={editingBoard.integration ?? "local"}
                  disabled={busy}
                  onChange={(event) => {
                    const integration = event.target.value;
                    void action(async () => {
                      const updated = await api<Board>(
                        `/boards/${editingBoard.id}/settings`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ integration }),
                        },
                      );
                      setBoards((previous) =>
                        previous.map((item) =>
                          item.id === updated.id ? updated : item,
                        ),
                      );
                      setEditingBoard(updated);
                    });
                  }}
                  className="mt-2 block w-full rounded-md border border-border bg-background px-3 py-2 text-xs"
                >
                  <option value="local">Local merge</option>
                  <option value="github-pr">GitHub pull requests</option>
                </select>
              </label>
              {editingBoard.integrationNote && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {editingBoard.integrationNote}
                </p>
              )}
              {editingBoard.githubMainProtected &&
                !editingBoard.integrationChosen &&
                (editingBoard.integration ?? "local") === "local" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const updated = await api<Board>(
                          `/boards/${editingBoard.id}/settings`,
                          {
                            method: "PATCH",
                            body: JSON.stringify({ integration: "local" }),
                          },
                        );
                        setBoards((previous) =>
                          previous.map((item) =>
                            item.id === updated.id ? updated : item,
                          ),
                        );
                        setEditingBoard(updated);
                      })
                    }
                  >
                    Keep Local merge
                  </Button>
                )}
              {editingBoard.integrationError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {editingBoard.integrationError}
                </p>
              )}
              {(editingBoard.integration ?? "local") === "local" && (
                <label className="mt-4 flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label="Push main to origin after merging"
                    checked={editingBoard.pushMainAfterMerge ?? false}
                    disabled={busy}
                    onChange={(event) => {
                      const pushMainAfterMerge = event.target.checked;
                      void action(async () => {
                        const updated = await api<Board>(
                          `/boards/${editingBoard.id}/settings`,
                          {
                            method: "PATCH",
                            body: JSON.stringify({ pushMainAfterMerge }),
                          },
                        );
                        setBoards((previous) =>
                          previous.map((item) =>
                            item.id === updated.id ? updated : item,
                          ),
                        );
                        setEditingBoard(updated);
                      });
                    }}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    Push main to origin after merging
                    <span className="block text-muted-foreground">
                      Runs git push origin main after each local merge,
                      including merges made by the agent reviewer. If the push
                      fails, the merge stays and the card&apos;s History says
                      why.
                    </span>
                  </span>
                </label>
              )}
              <LocalMerges
                boardId={editingBoard.id}
                integration={editingBoard.integration ?? "local"}
                onChanged={refresh}
              />
            </div>
          )}
          {pickupBoard && (
            <div className="mt-8 border-t border-border pt-5 text-sm">
              <div className="font-medium">Auto pickup</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Automatically start Ready cards in creation order, up to the
                concurrency limit including manual runs. The configurable
                rolling start limit and the optional daily cost budget protect
                against unbounded paid runs. A failed automatic run or
                interrupted run pauses pickup. Starting Pi may spend model
                tokens. Turn off pickup to stop new starts; existing runs
                continue.
              </p>
              <label className="mt-4 flex items-center gap-2 text-xs">
                Concurrent runs{" "}
                <select
                  aria-label="Auto pickup concurrency"
                  value={pickupBoard.pickupConcurrency}
                  disabled={busy}
                  onChange={(event) => {
                    const limit = Number(event.target.value);
                    void action(async () => {
                      const updated = await api<Board>(
                        `/boards/${pickupBoard.id}/settings`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            autoPickupEnabled: pickupBoard.autoPickupEnabled,
                            pickupConcurrency: limit,
                          }),
                        },
                      );
                      updateBoard(updated);
                    });
                  }}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  {[1, 2, 3, 4].map((limit) => (
                    <option key={limit} value={limit}>
                      {limit}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mt-3 flex items-center gap-2 text-xs">
                Automatic starts per 24 hours{" "}
                <select
                  aria-label="Auto pickup daily start limit"
                  value={pickupBoard.pickupDailyLimit}
                  disabled={busy}
                  onChange={(event) => {
                    const limit = Number(event.target.value);
                    if (
                      (limit === 0 || limit > pickupBoard.pickupDailyLimit) &&
                      pickupBoard.autoPickupEnabled &&
                      !window.confirm(
                        `Raise automatic starts to ${limit === 0 ? "no limit" : `${limit} per 24 hours`} for ${pickupBoard.repo}? Ready cards may start immediately and spend model tokens.`,
                      )
                    )
                      return;
                    void action(async () => {
                      const updated = await api<Board>(
                        `/boards/${pickupBoard.id}/settings`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            autoPickupEnabled: pickupBoard.autoPickupEnabled,
                            pickupConcurrency: pickupBoard.pickupConcurrency,
                            pickupDailyLimit: limit,
                          }),
                        },
                      );
                      updateBoard(updated);
                    });
                  }}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value={0}>No limit</option>
                  {Array.from({ length: 99 }, (_, index) => index + 1).map(
                    (limit) => (
                      <option key={limit} value={limit}>
                        {limit}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <p className="mt-2 text-xs text-muted-foreground">
                {pickupBoard.pickupDailyLimit === 0
                  ? `${pickupBoard.autoPickupStarts} starts in the rolling day (no limit).`
                  : `${pickupBoard.autoPickupStarts} / ${pickupBoard.pickupDailyLimit} starts in the rolling day.`}
                {pickupBoard.autoPickupNextAt &&
                  ` Next slot around ${date(pickupBoard.autoPickupNextAt)}.`}
              </p>
              <form
                className="mt-3 flex flex-wrap items-center gap-2 text-xs"
                onSubmit={(event) => saveCostBudget(event, pickupBoard)}
              >
                <label className="flex items-center gap-2">
                  Daily cost budget (USD){" "}
                  <input
                    aria-label="Auto pickup daily cost budget"
                    inputMode="decimal"
                    placeholder="Off"
                    value={budgetDraft}
                    disabled={busy}
                    onChange={(event) => setBudgetDraft(event.target.value)}
                    className="w-24 rounded-md border border-border bg-background px-2 py-1"
                  />
                </label>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={
                    busy ||
                    budgetDraft.trim() ===
                      (savedBudget === null ? "" : String(savedBudget))
                  }
                >
                  Save budget
                </Button>
              </form>
              <p className="mt-2 text-xs text-muted-foreground">
                {formatCost(pickupBoard.cost24h ?? 0)} spent in the last 24
                hours
                {typeof pickupBoard.pickupCostBudget === "number"
                  ? ` of ${formatCost(pickupBoard.pickupCostBudget)}.`
                  : "."}{" "}
                Leave blank for no budget. At the budget, automatic pickup
                waits; running work and manual starts continue.
              </p>
              {pickupBoard.autoPickupEnabled &&
                pickupBoard.pickupDailyLimit > 0 &&
                pickupBoard.autoPickupStarts >=
                  pickupBoard.pickupDailyLimit && (
                  <Button
                    className="mt-2"
                    variant="outline"
                    disabled={busy}
                    onClick={() => resetPickupLimit(pickupBoard)}
                  >
                    Reset start limit
                  </Button>
                )}
              <Button
                className="mt-3"
                variant={pickupBoard.autoPickupEnabled ? "outline" : "default"}
                disabled={busy}
                onClick={() => {
                  const enable = !pickupBoard.autoPickupEnabled;
                  if (
                    enable &&
                    !window.confirm(
                      `Enable automatic Pi pickup for ${pickupBoard.repo}? Up to ${pickupBoard.pickupConcurrency} paid Pi runs can start without another click, ${pickupBoard.pickupDailyLimit === 0 ? "with no daily start limit" : `up to ${pickupBoard.pickupDailyLimit} automatic starts per rolling 24 hours`}. Ready cards may start immediately.`,
                    )
                  )
                    return;
                  void action(async () => {
                    const updated = await api<Board>(
                      `/boards/${pickupBoard.id}/settings`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({
                          autoPickupEnabled: enable,
                          pickupConcurrency: pickupBoard.pickupConcurrency,
                        }),
                      },
                    );
                    updateBoard(updated);
                  });
                }}
              >
                {pickupBoard.autoPickupEnabled
                  ? "Disable auto pickup"
                  : "Enable auto pickup"}
              </Button>
              {pickupBoard.autoPickupError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  Paused: {pickupBoard.autoPickupError}
                </p>
              )}
            </div>
          )}
          {editingBoard && (
            <div className="mt-8 border-t border-border pt-5 text-sm">
              <div className="font-medium">Unattended review</div>
              <p className="mt-2 text-xs text-muted-foreground">
                A Pi reviewer with full tools inspects new Review cards in their
                worktrees; the verification command runs first. At most 3 merges
                per 24 hours. Findings, errors, or changes require human review.
                Local merge only, never push. Auto-review alone does not start
                Ready cards; enable Auto pickup above.
              </p>
              <label className="mt-4 block text-xs">
                Verification command
                <input
                  aria-label="Auto-review verification command"
                  value={verificationDraft}
                  onChange={(event) => setVerificationDraft(event.target.value)}
                  disabled={busy}
                  placeholder="npm test && npm run build"
                  className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                />
              </label>
              <Button
                className="mt-3"
                variant={editingBoard.autoReviewEnabled ? "outline" : "default"}
                disabled={
                  busy ||
                  (!editingBoard.autoReviewEnabled && !verificationDraft.trim())
                }
                onClick={() => {
                  const enable =
                    !editingBoard.autoReviewEnabled ||
                    verificationDraft.trim() !==
                      editingBoard.verificationCommand;
                  if (
                    enable &&
                    !window.confirm(
                      `Enable unattended agent review and up to 3 local merges per 24 hours for ${editingBoard.repo}? This may spend model tokens. Only new reviews after enabling are eligible.`,
                    )
                  )
                    return;
                  void action(async () => {
                    const updated = await api<Board>(
                      `/boards/${editingBoard.id}/settings`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({
                          autoReviewEnabled: enable,
                          verificationCommand: verificationDraft,
                        }),
                      },
                    );
                    setBoards((previous) =>
                      previous.map((item) =>
                        item.id === updated.id ? updated : item,
                      ),
                    );
                    setEditingBoard(updated);
                    setVerificationDraft(updated.verificationCommand);
                  });
                }}
              >
                {editingBoard.autoReviewEnabled
                  ? verificationDraft.trim() !==
                    editingBoard.verificationCommand
                    ? "Save and re-enable"
                    : "Disable auto-review"
                  : "Enable auto-review"}
              </Button>
              {editingBoard.autoReviewEnabled && (
                <p className="mt-2 text-xs text-primary">
                  Enabled since{" "}
                  {editingBoard.autoReviewEnabledAt &&
                    date(editingBoard.autoReviewEnabledAt)}
                  . New reviewed runs can merge without approval.
                </p>
              )}
            </div>
          )}
          {editingBoard && (
            <div className="mt-8 border-t border-border pt-5 text-sm">
              <div className="font-medium">Pi models</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Overrides for this repository's Pi runs. Blank fields inherit
                the global setting from Settings.
              </p>
              <AgentModelFields
                key={`${editingBoard.id}-${JSON.stringify(editingBoard.agentModels)}`}
                scope="repository"
                value={editingBoard.agentModels ?? emptyAgentModels()}
                inherited={settings?.agentModels ?? emptyAgentModels()}
                disabled={busy}
                onSave={(agentModels) =>
                  void action(async () => {
                    const updated = await api<Board>(
                      `/boards/${editingBoard.id}/settings`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({ agentModels }),
                      },
                    );
                    setBoards((previous) =>
                      previous.map((item) =>
                        item.id === updated.id ? updated : item,
                      ),
                    );
                    setEditingBoard(updated);
                  })
                }
              />
            </div>
          )}
          {editingBoard && (
            <div className="mt-8 border-t border-border pt-5">
              <div className="text-sm font-medium">Remove repository</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Hides this board. Cards, runs, and worktrees stay on disk. Add
                the repository again to restore them.
              </p>
              <Button
                variant="destructive"
                className="mt-4"
                disabled={busy}
                onClick={() => removeBoard(editingBoard)}
              >
                Remove repository from Bakery
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="text-lg font-semibold tracking-tight">
            {editing ? "Edit card" : "New card"}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            Work in {editing?.repo ?? currentBoard?.repo}.
          </DialogDescription>
          <CardForm
            key={editing?.id ?? "new"}
            initial={editing ?? undefined}
            onSubmit={(value) =>
              action(async () => {
                const saved = await api<Card>(
                  `/boards/${editing ? boards.find((item) => item.repo === editing.repo)?.id : boardId}/cards${editing ? `/${editing.id}` : ""}`,
                  {
                    method: editing ? "PATCH" : "POST",
                    body: JSON.stringify(value),
                  },
                );
                setCreating(false);
                setEditing(null);
                setSelected(saved.id);
              })
            }
            busy={busy}
          />
        </DialogContent>
      </Dialog>
      {!showShortcuts && leaderPending && (
        <div
          role="status"
          aria-label="Go to"
          className="fixed right-3 bottom-3 z-40 rounded-md border bg-card/60 px-3 py-2 text-xs backdrop-blur-md"
        >
          <div className="mb-1 text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
              g
            </kbd>{" "}
            then…
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {shortcutList
              .filter(([keys]) => keys.startsWith("g "))
              .map(([keys, label]) => (
                <Fragment key={keys}>
                  <dt>
                    <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
                      {keys.slice(2)}
                    </kbd>
                  </dt>
                  <dd>{label.replace(/^Go to /, "")}</dd>
                </Fragment>
              ))}
          </dl>
        </div>
      )}
      {!showShortcuts && !leaderPending && (
        <button
          type="button"
          onClick={() => setShowShortcuts(true)}
          className="fixed right-3 bottom-3 z-40 flex items-center gap-1.5 rounded-md border bg-card/60 px-2 py-1 text-xs text-muted-foreground opacity-60 backdrop-blur-md transition-opacity hover:opacity-100"
        >
          Press
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            ?
          </kbd>
          for shortcuts
        </button>
      )}
      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent
          className="bg-card/80 backdrop-blur-md"
          overlayClassName="bg-black/40"
          aria-label="Keyboard shortcuts"
        >
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            Shortcuts are off while you type in a field.
          </DialogDescription>
          <dl className="mt-5 grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
            {shortcutList.map(([keys, label]) => (
              <Fragment key={label}>
                <dt className="flex gap-1">
                  {keys.split(" ").map((part, index) => (
                    <kbd
                      key={index}
                      className="rounded border border-border bg-background/70 px-1.5 py-0.5 font-mono text-xs"
                    >
                      {part}
                    </kbd>
                  ))}
                </dt>
                <dd>{label}</dd>
              </Fragment>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
      {detailBoardId && selected && (
        <CardDetails
          key={selected}
          boardId={detailBoardId}
          integration={
            boards.find((item) => item.id === detailBoardId)?.integration
          }
          card={card}
          boardCards={scopeCards.filter((item) => item.repo === card?.repo)}
          onOpenCard={setSelected}
          onOpenPullRequest={(() => {
            const owner = boards.find((item) => item.id === detailBoardId);
            return owner && card?.prNumber && supportsPullRequests(owner)
              ? () => {
                  setSelected(null);
                  openPulls(owner.id, card.prNumber ?? null);
                }
              : undefined;
          })()}
          settings={settings}
          conflict={mergeConflicts.find((item) => item.cardId === selected)}
          queue={
            reviewQueue && selected
              ? {
                  position: reviewQueue.indexOf(selected) + 1,
                  total: reviewQueue.length,
                  onNext: advanceQueue,
                }
              : undefined
          }
          onClose={() => {
            setSelected(null);
            setReviewQueue(null);
          }}
          onEdit={(item) => {
            setEditing(item);
            setSelected(null);
          }}
          onRefresh={refresh}
          onError={setError}
          onConflict={(conflict) =>
            setMergeConflicts((previous) =>
              conflict
                ? [
                    ...previous.filter(
                      (item) => item.cardId !== conflict.cardId,
                    ),
                    conflict,
                  ]
                : previous.filter((item) => item.cardId !== selected),
            )
          }
        />
      )}
    </div>
  );
}
function PullRequestBadge({
  card,
  onOpen,
}: {
  card: Card;
  onOpen?: () => void;
}) {
  const tone =
    card.prState === "MERGED"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      : card.prState === "CLOSED" || card.prChecks === "failing"
        ? "border-red-500/40 bg-red-500/10 text-red-500"
        : "border-border text-muted-foreground";
  return (
    <span
      data-testid="pr-badge"
      role={onOpen ? "link" : undefined}
      onClick={
        onOpen
          ? (event) => {
              event.stopPropagation();
              onOpen();
            }
          : undefined
      }
      title={[
        card.prUrl,
        card.prState?.toLowerCase(),
        card.prChecks && `checks ${card.prChecks}`,
        card.prError,
      ]
        .filter(Boolean)
        .join(" \u00b7 ")}
      className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium ${tone}`}
    >
      PR #{card.prNumber}
      {card.prChecks && card.prState === "OPEN"
        ? ` \u00b7 ${card.prChecks}`
        : ""}
    </span>
  );
}
function OriginMainBadge({ state }: { state: "pushed" | "local" }) {
  return (
    <span
      data-testid="origin-main-badge"
      title={
        state === "pushed"
          ? "The merge commit is on origin/main, as of the last fetch"
          : "Merged into local main only; origin/main did not have it at the last fetch. Push main to publish it"
      }
      className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
        state === "pushed"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
          : "border-amber-500/40 bg-amber-500/10 text-amber-500"
      }`}
    >
      {state === "pushed" ? "On origin/main" : "Merged locally, not pushed"}
    </span>
  );
}
/** Says a Review card is your turn, who has it if not, or how long a running agent has been quiet. */
function ActivityBadge({
  card,
  activity,
}: {
  card: Card;
  activity: ReturnType<typeof cardActivity>;
}) {
  if (card.status === "interrupted")
    return (
      <span
        data-testid="activity-badge"
        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      >
        <CirclePause size={10} aria-hidden />
        Interrupted
      </span>
    );
  if (card.status === "review" && card.reviewWait)
    return (
      <span
        data-testid="activity-badge"
        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      >
        {activity === "working" ? (
          <LoaderCircle size={10} className="animate-spin" aria-hidden />
        ) : (
          <Hourglass size={10} aria-hidden />
        )}
        {reviewWaitLabels[card.reviewWait]}
      </span>
    );
  if (needsYourReview(card))
    return (
      <span
        data-testid="activity-badge"
        title="Ready for your review"
        className="flex items-center gap-1 rounded border border-status-review bg-status-review px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[.1em] text-background"
      >
        <Eye size={10} aria-hidden />
        Your turn
      </span>
    );
  if (activity !== "quiet" || !card.lastActivityAt) return null;
  const minutes = Math.round(
    (Date.now() - Date.parse(card.lastActivityAt)) / 60_000,
  );
  return (
    <span
      data-testid="activity-badge"
      title="The agent has reported nothing for a while. A long command can be quiet; check the attempt log if it stays quiet."
      className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500"
    >
      <CirclePause size={10} aria-hidden />
      Quiet {minutes}m
    </span>
  );
}

function WaitingBadge({ waiting }: { waiting: Card[] }) {
  return (
    <span
      data-testid="waiting-badge"
      title={`Starts after ${waiting.map((item) => item.title).join(", ")} ${waiting.length === 1 ? "is" : "are"} Done`}
      className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[.1em] text-sky-500"
    >
      Waiting on {waiting.length}
    </span>
  );
}
function PriorityBadge({ priority }: { priority: Priority }) {
  const tone =
    priority > 0
      ? priority > 1
        ? "border-red-500/40 bg-red-500/10 text-red-500"
        : "border-orange-500/40 bg-orange-500/10 text-orange-500"
      : "border-border bg-muted/40 text-muted-foreground";
  return (
    <span
      data-testid="priority-badge"
      title={`${priorityLabel(priority)} priority`}
      className={`rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[.1em] ${tone}`}
    >
      {priorityLabel(priority)}
    </span>
  );
}
const shortcutList: [string, string][] = [
  ["n", "New card"],
  ["j k", "Next / previous card"],
  ["h l", "Card in previous / next lane"],
  ["Enter", "Open focused card"],
  ["/", "Search cards"],
  ["g t", "Go to Today"],
  ["g b", "Go to Board"],
  ["g p", "Go to Pull requests"],
  ["g s", "Go to Statistics"],
  ["g l", "Go to Logs"],
  ["⌘ Enter", "Create or save card in the form"],
  ["?", "Show or hide this cheat sheet"],
];
function CardForm({
  onSubmit,
  busy,
  initial,
}: {
  onSubmit: (value: {
    title: string;
    body: string;
    priority: Priority;
  }) => void;
  busy: boolean;
  initial?: Card;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 0);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ title, body, priority });
  }
  const input =
    "w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary";
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      className="mt-6 space-y-5"
    >
      <label className="block text-xs font-medium">
        Title
        <input
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          className={`mt-2 ${input}`}
        />
      </label>
      <label className="block text-xs font-medium">
        Description
        <textarea
          value={body}
          maxLength={16000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Context, acceptance criteria, and anything the agent should know…"
          rows={5}
          className={`mt-2 resize-y ${input}`}
        />
      </label>
      <label className="block text-xs font-medium">
        Priority
        <select
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value) as Priority)}
          className={`mt-2 ${input}`}
        >
          {priorities.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        This card uses the selected repository. New cards start in Triage. Move
        one to Ready before starting a run. Creating or moving a card does not
        start an agent.
      </p>
      <div className="flex justify-end">
        <Button disabled={busy} type="submit">
          {initial ? "Save changes" : "Create card"} <Plus size={15} />
        </Button>
      </div>
    </form>
  );
}
