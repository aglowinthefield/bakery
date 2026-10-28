/** An item an agent listed under a "Follow-ups" heading in its report: work for later, not part of this card. */
export type FollowUp = { title: string; body: string };

/**
 * Reads the list items under the report's last "Follow-ups" (or "Follow up") heading, up to the next heading.
 * A top-level bullet starts an item; indented lines continue it. The first line, with Markdown emphasis and
 * code ticks stripped, is the title, capped at 120 characters; the full item text is the body.
 */
export function followUps(report: string): FollowUp[] {
  const lines = report.split("\n");
  let start = -1;
  lines.forEach((line, index) => { if (/^#{1,6}\s*\**follow[- ]?ups?\b/i.test(line.trim())) start = index; });
  if (start < 0) return [];
  const items: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (/^([-*+]|\d+[.)])\s+/.test(line)) items.push([line.replace(/^([-*+]|\d+[.)])\s+/, "")]);
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1].push(line.trim());
  }
  return items.slice(0, 20).map(parts => {
    const text = parts.join("\n").trim();
    const first = parts[0].replace(/[*_`]/g, "").trim();
    return { title: first.length > 120 ? `${first.slice(0, 117)}...` : first, body: text };
  }).filter(item => item.title);
}
