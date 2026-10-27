import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { api } from "./api.js";
import type { Card } from "./model.js";

/** Local main has commits origin/main lacks. `resettable` means they are only published card merges. */
export type MainRecovery = {
  tip: string;
  originMain: string;
  recoveryBranch: string;
  localCommits: number;
  resettable: boolean;
  reason: string;
};
type LocalMerge = {
  card: Card;
  candidate: string;
  commits: number;
  blocker: string;
};

/**
 * Offers to reset local main to origin/main after saving its tip as
 * bakery-recovery/<sha>. Resets only when the operator confirms this tip.
 */
export function MainReset({
  boardId,
  main,
  onReset,
  onError,
}: {
  boardId: string;
  main: MainRecovery | null;
  onReset: (main: MainRecovery | null) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!main) return null;
  const commits = `${main.localCommits} commit${main.localCommits === 1 ? "" : "s"}`;
  if (!main.resettable)
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Local main has {commits} that origin/main lacks and stays as it is:{" "}
        {main.reason}.
      </p>
    );
  return (
    <div className="mt-3 rounded-md border border-border p-3 text-xs">
      <p>
        Local main has {commits} that origin/main lacks, all card merges now
        published as pull requests. Reset local main to origin/main (
        {main.originMain.slice(0, 12)})? Its current tip {main.tip.slice(0, 12)}{" "}
        is kept as {main.recoveryBranch}.
      </p>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          if (
            !window.confirm(
              `Reset local main from ${main.tip.slice(0, 12)} to origin/main ${main.originMain.slice(0, 12)}? The old tip is saved as ${main.recoveryBranch}.`,
            )
          )
            return;
          setBusy(true);
          onError("");
          try {
            const result = await api<{ main: MainRecovery | null }>(
              `/boards/${boardId}/main/reset`,
              { method: "POST", body: JSON.stringify({ tip: main.tip }) },
            );
            onReset(result.main);
          } catch (err) {
            onError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        Reset local main to origin/main
      </Button>
    </div>
  );
}

/**
 * Done cards Bakery merged into local main whose work is not on origin/main.
 * On a github-pr board each can be published as a pull request.
 */
export function LocalMerges({
  boardId,
  integration,
  onChanged,
}: {
  boardId: string;
  integration: "local" | "github-pr";
  onChanged: () => void;
}) {
  const [data, setData] = useState<{
    cards: LocalMerge[];
    main: MainRecovery | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setError("");
    api<{ cards: LocalMerge[]; main: MainRecovery | null }>(
      `/boards/${boardId}/local-merges`,
    )
      .then(
        (result) =>
          current &&
          setData({
            cards: Array.isArray(result?.cards) ? result.cards : [],
            main: result?.main ?? null,
          }),
      )
      .catch(
        (err) =>
          current && setError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      current = false;
    };
  }, [boardId, integration, reload]);
  if (!data && !error) return null;
  if (data && !data.cards.length && !data.main && !error) return null;
  return (
    <div className="mt-4 text-xs">
      {!!data?.cards.length && (
        <>
          <div className="font-medium">Merged only into local main</div>
          <p className="mt-1 text-muted-foreground">
            {integration === "github-pr"
              ? "Publish as PR pushes the approved work to bakery/<card>, opens a pull request, and moves the card back to Review until it merges."
              : "Switch to GitHub pull requests to publish these as pull requests."}
          </p>
          <ul className="mt-2 space-y-2">
            {data.cards.map((item) => (
              <li
                key={item.card.id}
                className="flex items-start justify-between gap-3"
              >
                <div>
                  <div>{item.card.title}</div>
                  {item.blocker && (
                    <div className="text-destructive">{item.blocker}</div>
                  )}
                </div>
                {integration === "github-pr" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !!item.blocker}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await api(
                          `/boards/${boardId}/cards/${item.card.id}/publish`,
                          { method: "POST" },
                        );
                        onChanged();
                        setReload((value) => value + 1);
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : String(err),
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Publish as PR
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {data && (
        <MainReset
          boardId={boardId}
          main={data.main}
          onError={setError}
          onReset={(main) => {
            setData({ ...data, main });
            onChanged();
          }}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
