import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";
import { highlightDiffCode, languageForPath } from "./review-diff.js";
import { cn } from "./lib/utils";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
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
