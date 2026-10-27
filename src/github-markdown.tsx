import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "./lib/utils";

/**
 * Renders GitHub-flavored markdown the way GitHub does: tables, task lists, strikethrough, autolinks, and the
 * HTML GitHub allows in comments (<details>, <summary>, <img>, <kbd>, ...). The HTML goes through GitHub's own
 * sanitize schema, so scripts, styles and event handlers never reach the page.
 */
export function GithubMarkdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          img: ({ node: _node, ...props }) => <img {...props} loading="lazy" />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
