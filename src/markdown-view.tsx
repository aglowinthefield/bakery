import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";
import { highlightDiffCode, languageForPath } from "./review-diff.js";
import { cn } from "./lib/utils";
import type { Card, Status } from "./model.js";

/** Lets a card id in rendered text become a chip that summarises and opens that card. */
export const CardLinks = createContext<{
  open: (id: string) => void;
  /** The card's title and status when it is known here. */
  card: (id: string) => Pick<Card, "title" | "status"> | undefined;
  /** The card's own URL, so the chip also works as a link (new tab, copy link). */
  href?: (id: string) => string;
} | null>(null);

const statusDot: Record<Status, string> = {
  triage: "bg-muted-foreground/60",
  ready: "bg-sky-500",
  running: "bg-amber-500",
  review: "bg-violet-500",
  failed: "bg-red-500",
  interrupted: "bg-orange-500",
  done: "bg-emerald-500",
  archived: "bg-muted-foreground/40",
};
const statusName = (status: Status) =>
  status === "done" || status === "archived" ? "finished" : status;

const cardId =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** A short, clickable stand-in for a card's full id. */
export function CardChip({ id }: { id: string }) {
  const links = useContext(CardLinks);
  const short = id.slice(0, 8);
  const card = links?.card(id);
  const className =
    "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-px align-baseline text-[0.85em] text-foreground/80 no-underline";
  if (!links)
    return (
      <code className={cn(className, "font-mono")} title={id}>
        {short}
      </code>
    );
  const label = card ? `${card.title} (${statusName(card.status)}, ${id})` : id;
  const content = card ? (
    <>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", statusDot[card.status])}
      />
      <span className="min-w-0 max-w-[28ch] truncate">{card.title}</span>
      <span className="shrink-0 font-mono text-muted-foreground">{short}</span>
    </>
  ) : (
    <span className="font-mono">{short}</span>
  );
  const interactive = cn(
    className,
    "cursor-pointer hover:border-primary hover:text-primary",
  );
  const href = links.href?.(id);
  if (href)
    return (
      <a
        href={href}
        title={label}
        data-card-chip={id}
        className={interactive}
        onClick={(event) => {
          // Modified clicks keep the browser's own handling (new tab, new window).
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          links.open(id);
        }}
      >
        {content}
      </a>
    );
  return (
    <button
      type="button"
      title={label}
      data-card-chip={id}
      className={interactive}
      onClick={() => links.open(id)}
    >
      {content}
    </button>
  );
}

function withCardChips(text: string, key: number): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(cardId)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<CardChip key={`${key}-${match.index}`} id={match[0]} />);
    last = match.index + match[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return withCardChips(node.text, index);
      case "break":
        return <br key={index} />;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children)}</del>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  // Reuse the review diff highlighter; it escapes code for unknown languages.
  const path = `snippet.${lang}`;
  return (
    <pre data-language={lang || undefined}>
      {lang && languageForPath(path) ? (
        <code
          dangerouslySetInnerHTML={{ __html: highlightDiffCode(text, path) }}
        />
      ) : (
        <code>{text}</code>
      )}
    </pre>
  );
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const Heading = `h${block.level}` as "h1";
        return <Heading key={index}>{renderInline(block.children)}</Heading>;
      }
      case "paragraph":
        return <p key={index}>{renderInline(block.children)}</p>;
      case "code":
        return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case "quote":
        return (
          <blockquote key={index}>{renderBlocks(block.children)}</blockquote>
        );
      case "rule":
        return <hr key={index} />;
      case "table": {
        const cell = (children: Inline[], column: number, header: boolean) => {
          const Cell = header ? "th" : "td";
          return (
            <Cell
              key={column}
              style={{ textAlign: block.align[column] ?? undefined }}
            >
              {renderInline(children)}
            </Cell>
          );
        };
        return (
          <div key={index} className="markdown-table">
            <table>
              <thead>
                <tr>{block.header.map((c, i) => cell(c, i, true))}</tr>
              </thead>
              {block.rows.length > 0 && (
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>{row.map((c, i) => cell(c, i, false))}</tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        );
      }
      case "list": {
        const items = block.items.map((item, itemIndex) => (
          <li
            key={itemIndex}
            data-task={item.checked === undefined ? undefined : ""}
          >
            {item.checked !== undefined && (
              <input
                type="checkbox"
                checked={item.checked}
                disabled
                aria-label={item.checked ? "Completed" : "Not completed"}
              />
            )}
            {renderBlocks(item.children)}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
    }
  });
}

/** Renders a card description written in markdown. Raw HTML is shown as text. */
export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={cn("markdown", className)}>{renderBlocks(blocks)}</div>
  );
}
