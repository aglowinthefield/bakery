/**
 * Bakery's own markdown links (`![shot.png](/api/boards/…/attachments/ID)` from `bakery-cli attach`, chat images) are
 * relative to the local Bakery server, so GitHub cannot load them: they render as broken images or dead links. Screenshots
 * stay on this machine by design, never uploaded to GitHub or any other service, so before text goes into a pull request
 * body or comment each such link becomes plain text naming the file and saying it is kept in Bakery.
 *
 * Only Bakery's stored-file URL shapes are rewritten (card attachments and chat images); other links, such as
 * `/api/users`, are left alone. Links written entirely inside code or a fenced block are left alone, but a code span
 * inside a link's label is part of that link.
 */
const URL_SHAPE = String.raw`\/api\/boards\/[\w-]+\/(?:cards\/[\w-]+\/attachments\/[\w-]+|chats\/[\w-]+\/images\/[a-f0-9]{64})`;
// Leftmost match wins, so a link that starts before a backtick takes its code spans with it, while a code span that
// starts first protects any link inside it. A fence runs to its closing line, or to the end of the text.
const TOKEN = new RegExp(
  String.raw`(?:^|\n)(?:\x60{3}|~{3})[\s\S]*?(?:\n(?:\x60{3}|~{3})[^\n]*(?=\n|$)|$)` +
    String.raw`|\x60[^\x60\n]+\x60` +
    String.raw`|(!?)\[((?:[^\]\n\x60]|\x60[^\x60\n]*\x60)*)\]\((${URL_SHAPE})\)`,
  "g",
);

export function githubMarkdown(text: string): string {
  return text.replace(TOKEN, (match, image: string | undefined, label: string | undefined) => {
    if (label === undefined) return match; // Code.
    const name = label.replace(/\x60/g, "").trim() || (image ? "image" : "file");
    return image
      ? `_Screenshot ${name}: kept in Bakery as a card attachment, not published to GitHub_`
      : `${name} (kept in Bakery as a card attachment, not published to GitHub)`;
  });
}
