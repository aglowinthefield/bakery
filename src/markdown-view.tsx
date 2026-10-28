import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";
import { highlightDiffCode, languageForPath } from "./review-diff.js";
import { cn } from "./lib/utils";

/** Lets a card id in rendered text become a chip that opens that card. */
export const CardLinks = createContext<{
  open: (id: string) => void;
  title: (id: string) => string | undefined;
} | null>(null);

const cardId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** A short, clickable stand-in for a card's full id. */
export function CardChip({ id }: { id: string }) {
  const links = useContext(CardLinks);
  const short = id.slice(0, 8);
  const title = links?.title(id);
  const className =
    "mx-0.5 inline-flex items-center rounded border border-border bg-muted px-1.5 py-px align-baseline font-mono text-[0.85em] text-foreground/80";
  if (!links) return <code className={className} title={id}>{short}</code>;
  return (
    <button
      type="button"
      title={title ? `${title} (${id})` : id}
      className={`${className} hover:border-primary hover:text-primary`}
      onClick={() => links.open(id)}
    >
      {short}
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
