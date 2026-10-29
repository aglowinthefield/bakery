import type { Card } from "../model.js";

/** Per-board Visualizer. For now it only lists the board's cards; later work replaces this body. */
export function Visualizer({
  cards,
  loaded,
  onOpenCard,
}: {
  cards: Card[];
  /** False until the board's first fetch lands, so an unloaded board is not shown as empty. */
  loaded: boolean;
  onOpenCard: (id: string) => void;
}) {
  if (!loaded)
    return (
      <p className="px-6 py-6 text-sm text-muted-foreground lg:px-10">
        Loading cards…
      </p>
    );
  if (!cards.length)
    return (
      <p className="px-6 py-6 text-sm text-muted-foreground lg:px-10">
        No cards on this board yet.
      </p>
    );
  return (
    <ul aria-label="Cards" className="px-6 py-6 lg:px-10">
      {cards.map((card) => (
        <li key={card.id}>
          <button
            onClick={() => onOpenCard(card.id)}
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm hover:bg-accent/30"
          >
            <span className="truncate">{card.title}</span>
            <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
              {card.status}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
