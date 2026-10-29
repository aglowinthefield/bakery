// A small markdown parser for card descriptions. It produces a tree that the
// React renderer turns into elements, so raw HTML in a description is always
// shown as text and never injected into the page.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" };

export type ListItem = { checked?: boolean; children: Block[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "rule" }
  | {
      type: "table";
      align: ("left" | "center" | "right" | null)[];
      header: Inline[][];
      rows: Inline[][][];
    };

const MAX_DEPTH = 8;

const fenceOpen = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const headingLine = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const ruleLine = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const quoteLine = /^ {0,3}> ?(.*)$/;
const listLine = /^( {0,3})([-*+]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/;
const setextLine = /^ {0,3}(=+|-+)[ \t]*$/;

const isBlank = (line: string) => line.trim() === "";

function listMarker(line: string) {
  const match = listLine.exec(line);
  if (!match) return null;
  const [, indent, marker, number, gap = "", rest = ""] = match;
  // A marker followed by 5+ spaces keeps one space as the gap (CommonMark).
  const gapWidth = rest === "" ? 1 : gap.length > 4 ? 1 : gap.length;
  const content = gap.length > 4 ? gap.slice(1) + rest : rest;
  return {
    ordered: number !== undefined,
    // Bullets of different characters, or `.` versus `)`, start a new list.
    kind: number !== undefined ? marker.slice(-1) : marker,
    start: number !== undefined ? Number(number) : 1,
    width: indent.length + marker.length + gapWidth,
    content,
  };
}

const tableDelimiter =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// Splits a table row on unescaped pipes outside code spans.
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  const cells: string[] = [];
  let cell = "";
  let index = 0;
  let closed = false;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\" && text[index + 1] === "|") {
      cell += "|";
      index += 2;
    } else if (character === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(run, index + run.length);
      const stop = end >= 0 ? end + run.length : index + run.length;
      cell += text.slice(index, stop);
      index = stop;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      index++;
      closed = index >= text.length;
    } else {
      cell += character;
      index++;
    }
  }
  if (!closed) cells.push(cell.trim());
  return cells;
}

function startsTable(lines: string[], index: number) {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (delimiter === undefined || !header.includes("|")) return false;
  if (!tableDelimiter.test(delimiter) || !delimiter.includes("-")) return false;
  if (!delimiter.includes("|") && !header.trim().startsWith("|")) return false;
  return splitRow(header).length === splitRow(delimiter).length;
}

function startsBlock(line: string, inParagraph: boolean) {
  if (fenceOpen.test(line) || headingLine.test(line) || quoteLine.test(line))
    return true;
  if (ruleLine.test(line)) return true;
  const item = listMarker(line);
  if (!item) return false;
  // Inside a paragraph, only a non-empty bullet or an item numbered 1 starts
  // a list, so prose like "2024. was busy" stays a sentence.
  return (
    !inParagraph ||
    (item.content.trim() !== "" && (!item.ordered || item.start === 1))
  );
}

function stripIndent(line: string, width: number) {
  let index = 0;
  while (index < width && line[index] === " ") index++;
  return line.slice(index);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index++;
      continue;
    }

    const fence = fenceOpen.exec(line);
    if (fence) {
      const [, indent, marker, lang] = fence;
      const body: string[] = [];
      index++;
      const close = new RegExp(
        `^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`,
      );
      while (index < lines.length && !close.test(lines[index])) {
        body.push(stripIndent(lines[index], indent.length));
        index++;
      }
      index++; // closing fence, or past the end of an unclosed block
      blocks.push({
        type: "code",
        lang: lang.toLowerCase(),
        text: body.join("\n"),
      });
      continue;
    }

    const heading = headingLine.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2] ?? "", depth),
      });
      index++;
      continue;
    }

    if (ruleLine.test(line)) {
      blocks.push({ type: "rule" });
      index++;
      continue;
    }

    if (quoteLine.test(line)) {
      const body: string[] = [];
      while (index < lines.length && !isBlank(lines[index])) {
        const quoted = quoteLine.exec(lines[index]);
        if (quoted) body.push(quoted[1]);
        else if (startsBlock(lines[index], true)) break;
        else body.push(lines[index]); // lazy paragraph continuation
        index++;
      }
      blocks.push(
        depth >= MAX_DEPTH
          ? {
              type: "paragraph",
              children: [{ type: "text", text: body.join("\n") }],
            }
          : { type: "quote", children: parseBlocks(body, depth + 1) },
      );
      continue;
    }

    if (startsTable(lines, index)) {
      const align = splitRow(lines[index + 1]).map((cell) =>
        cell.startsWith(":")
          ? cell.endsWith(":")
            ? ("center" as const)
            : ("left" as const)
          : cell.endsWith(":")
            ? ("right" as const)
            : null,
      );
      const fit = (cells: string[]) =>
        align.map((_, column) => parseInline(cells[column] ?? "", depth));
      const header = fit(splitRow(line));
      index += 2;
      const rows: Inline[][][] = [];
      while (
        index < lines.length &&
        !isBlank(lines[index]) &&
        !startsBlock(lines[index], true)
      ) {
        rows.push(fit(splitRow(lines[index])));
        index++;
      }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const first = listMarker(line);
    if (first) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const item = listMarker(lines[index]);
        if (!item || item.kind !== first.kind || ruleLine.test(lines[index]))
          break;
        const body = [item.content];
        index++;
        while (index < lines.length) {
          const next = lines[index];
          if (isBlank(next)) {
            // A blank line stays in the item only if indented content follows.
            let ahead = index + 1;
            while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
            if (
              ahead < lines.length &&
              /^ */.exec(lines[ahead])![0].length >= item.width
            ) {
              body.push("");
              index++;
              continue;
            }
            break;
          }
          if (/^ */.exec(next)![0].length >= item.width) {
            body.push(stripIndent(next, item.width));
          } else if (
            !isBlank(body.at(-1)!) &&
            !startsBlock(next, true) &&
            listMarker(next)?.kind !== item.kind
          ) {
            body.push(next); // lazy paragraph continuation
          } else break;
          index++;
        }
        const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]);
        if (task) body[0] = body[0].slice(task[0].length);
        items.push({
          ...(task ? { checked: task[1] !== " " } : {}),
          children:
            depth >= MAX_DEPTH
              ? [
                  {
                    type: "paragraph",
                    children: [{ type: "text", text: body.join("\n") }],
                  },
                ]
              : parseBlocks(body, depth + 1),
        });
        // Blank lines between items keep the list going.
        let ahead = index;
        while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
        const following =
          ahead < lines.length ? listMarker(lines[ahead]) : null;
        if (!following || following.kind !== first.kind) break;
        index = ahead;
      }
      blocks.push({
        type: "list",
        ordered: first.ordered,
        start: first.start,
        items,
      });
      continue;
    }

    const paragraph = [line.trim()];
    index++;
    let level = 0;
    while (index < lines.length && !isBlank(lines[index])) {
      const setext = setextLine.exec(lines[index]);
      if (setext) {
        level = setext[1][0] === "=" ? 1 : 2;
        index++;
        break;
      }
      if (startsBlock(lines[index], true) || startsTable(lines, index)) break;
      paragraph.push(lines[index].trim());
      index++;
    }
    const children = parseInline(paragraph.join("\n"), depth);
    blocks.push(
      level
        ? { type: "heading", level, children }
        : { type: "paragraph", children },
    );
  }
  return blocks;
}

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function isSpace(character: string | undefined) {
  return character === undefined || /\s/.test(character);
}
function isWordCharacter(character: string | undefined) {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

// Finds the closing delimiter for emphasis that opens at `from`.
function findCloser(source: string, delimiter: string, from: number) {
  const character = delimiter[0];
  let found = from;
  while (found < source.length) {
    if (source[found] === "\\") {
      found += 2;
      continue;
    }
    if (source[found] === "`") {
      // Skip a code span so a delimiter inside code does not close emphasis.
      const run = /^`+/.exec(source.slice(found))![0];
      const end = source.indexOf(run, found + run.length);
      found = end >= 0 ? end + run.length : found + run.length;
      continue;
    }
    if (!source.startsWith(delimiter, found)) {
      found++;
      continue;
    }
    let runEnd = found;
    while (source[runEnd] === character) runEnd++;
    const runLength = runEnd - found;
    // A single `*` must not close on a `**` run, so `*a **b** c*` nests.
    if (delimiter.length === 1 && runLength === 2) {
      found = runEnd;
      continue;
    }
    const closer = runEnd - delimiter.length;
    if (
      closer > from &&
      !isSpace(source[closer - 1]) &&
      (character !== "_" || !isWordCharacter(source[closer + delimiter.length]))
    ) {
      return closer;
    }
    found = runEnd;
  }
  return -1;
}

function parseInline(source: string, depth: number): Inline[] {
  const nodes: Inline[] = [];
  let text = "";
  const flush = () => {
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) nodes.push({ type: "break" });
      if (part) nodes.push({ type: "text", text: part });
    });
    text = "";
  };
  const push = (node: Inline) => {
    flush();
    nodes.push(node);
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const rest = source.slice(index);

    if (character === "\\" && PUNCTUATION.test(source[index + 1] ?? "")) {
      text += source[index + 1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = source.indexOf(run, index + run.length);
      if (end >= 0 && source[end + run.length] !== "`") {
        let code = source.slice(index + run.length, end).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        push({ type: "code", text: code });
        index = end + run.length;
        continue;
      }
      text += run;
      index += run.length;
      continue;
    }

    if (character === "[" && depth < MAX_DEPTH) {
      const link = parseLink(source, index);
      if (link) {
        const children = parseInline(link.label, depth + 1);
        if (SAFE_URL.test(link.href))
          push({ type: "link", href: link.href, children });
        else {
          flush();
          nodes.push(...children);
        }
        index = link.end;
        continue;
      }
    }

    const autolink = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
    if (autolink) {
      push({
        type: "link",
        href: autolink[1],
        children: [{ type: "text", text: autolink[1] }],
      });
      index += autolink[0].length;
      continue;
    }

    if (!isWordCharacter(source[index - 1])) {
      const bare = /^https?:\/\/[^\s<]+/i.exec(rest);
      if (bare) {
        let url = bare[0];
        // Trailing punctuation usually ends the sentence, not the URL.
        while (
          /[.,:;!?'"*_~]$/.test(url) ||
          (url.endsWith(")") && count(url, "(") < count(url, ")"))
        )
          url = url.slice(0, -1);
        push({
          type: "link",
          href: url,
          children: [{ type: "text", text: url }],
        });
        index += url.length;
        continue;
      }
    }

    if (
      (character === "*" || character === "_" || character === "~") &&
      depth < MAX_DEPTH
    ) {
      const run = new RegExp(`^\\${character}+`).exec(rest)![0];
      const candidates =
        character === "~"
          ? run.length === 2
            ? ["~~"]
            : []
          : run.length >= 2
            ? [character.repeat(2), character]
            : [character];
      const opensWord =
        character !== "_" || !isWordCharacter(source[index - 1]);
      let matched = false;
      for (const delimiter of candidates) {
        if (!opensWord || isSpace(source[index + delimiter.length])) continue;
        const closer = findCloser(source, delimiter, index + delimiter.length);
        if (closer < 0) continue;
        const type =
          character === "~" ? "del" : delimiter.length === 2 ? "strong" : "em";
        push({
          type,
          children: parseInline(
            source.slice(index + delimiter.length, closer),
            depth + 1,
          ),
        });
        index = closer + delimiter.length;
        matched = true;
        break;
      }
      if (matched) continue;
      text += run;
      index += run.length;
      continue;
    }

    text += character;
    index++;
  }
  flush();
  return nodes;
}

function count(text: string, character: string) {
  return text.split(character).length - 1;
}

function parseLink(source: string, start: number) {
  let depth = 0;
  let index = start;
  for (; index < source.length; index++) {
    const character = source[index];
    if (character === "\\") index++;
    else if (character === "[") depth++;
    else if (character === "]" && --depth === 0) break;
  }
  if (index >= source.length || source[index + 1] !== "(") return null;
  const label = source.slice(start + 1, index);
  const target =
    /^\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/.exec(
      source.slice(index + 1),
    );
  if (!target) return null;
  const href = target[1].startsWith("<") ? target[1].slice(1, -1) : target[1];
  return { label, href, end: index + 1 + target[0].length };
}

export function parseMarkdown(source: string): Block[] {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");
  return parseBlocks(lines, 0);
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.text
        : node.type === "break"
          ? " "
          : "children" in node
            ? inlineText(node.children)
            : "",
    )
    .join("");
}

function blockText(blocks: Block[]): string[] {
  return blocks.flatMap((block): string[] => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return [inlineText(block.children)];
      case "code":
        return [block.text];
      case "quote":
        return blockText(block.children);
      case "list":
        return block.items.flatMap((item) => blockText(item.children));
      case "table":
        return [block.header, ...block.rows].map((row) =>
          row.map(inlineText).join(" "),
        );
      case "rule":
        return [];
    }
  });
}

/** Description text without markdown syntax, for compact previews. */
export function markdownToPlainText(source: string): string {
  return blockText(parseMarkdown(source)).join(" ").replace(/\s+/g, " ").trim();
}
