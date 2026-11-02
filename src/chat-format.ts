import type { Chat } from "./model.js";

/** How the chat list is arranged: one flat list, or under a heading per day of last activity. */
export type ChatGrouping = "none" | "date";
export const chatGroupings: { value: ChatGrouping; label: string }[] = [
  { value: "none", label: "None" },
  { value: "date", label: "Date" },
];
export const groupingKey = "bakery-chat-grouping";
/** The saved grouping; anything unknown reads as no grouping. */
export const readGrouping = (stored: string | null): ChatGrouping =>
  stored === "date" ? "date" : "none";

const labelChars = 40;

/** The first few words of `text`, on one line, cut with an ellipsis when anything was left out. */
export function fewWords(text: string, words: number, chars = labelChars) {
  const line = text
    .trim()
    .split("\n")[0]
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const all = line.split(" ").filter(Boolean);
  let short = all.slice(0, words).join(" ");
  let cut = all.length > words;
  if (short.length > chars) {
    const room = short.slice(0, chars);
    const space = room.lastIndexOf(" ");
    short = space > chars / 2 ? room.slice(0, space) : room;
    cut = true;
  }
  short = short.replace(/[\s,;:…-]+$/, "");
  return cut ? `${short}…` : short;
}

/** What the sidebar calls a chat: its few-word topic, else the first few words of its first message. */
export const chatLabel = (chat: Pick<Chat, "topic" | "title">) =>
  (chat.topic && fewWords(chat.topic, 6)) ||
  (chat.title && fewWords(chat.title, 5)) ||
  "New chat";

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const daysBetween = (earlier: Date, later: Date) =>
  Math.round((dayStart(later).getTime() - dayStart(earlier).getTime()) / 864e5);

/** The full local date and time, for a tooltip. */
export const fullTime = (iso: string, locale?: string) =>
  new Date(iso).toLocaleString(locale, {
    dateStyle: "full",
    timeStyle: "short",
  });

/** A short local time: the clock time today, else the date with the time, adding the year only for another year. */
export function shortTime(iso: string, now = new Date(), locale?: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (dayKey(date) === dayKey(now)) return time;
  const day = date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

/** Just the local clock time. */
export const clockTime = (iso: string, locale?: string) =>
  new Date(iso).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });

/** When a chat was last active, short enough for the sidebar: the time today, else just the date. */
export function shortDay(iso: string, now = new Date(), locale?: string) {
  const date = new Date(iso);
  if (dayKey(date) === dayKey(now))
    return date.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The heading for a day: Today, Yesterday, else the weekday and date, with the year only for another year. */
export function dayHeading(date: Date, now = new Date(), locale?: string) {
  const ago = daysBetween(date, now);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  return date.toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Chats under a heading per local day of last activity, newest day first and newest chat first within a day. */
export function groupByDate<T extends Pick<Chat, "updatedAt">>(
  chats: T[],
  now = new Date(),
  locale?: string,
): { key: string; heading: string; chats: T[] }[] {
  const groups = new Map<string, { date: Date; chats: T[] }>();
  for (const chat of chats) {
    const date = new Date(chat.updatedAt);
    const key = dayKey(date);
    const group = groups.get(key) ?? { date, chats: [] };
    group.chats.push(chat);
    groups.set(key, group);
  }
  const time = (chat: T) => new Date(chat.updatedAt).getTime();
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, group]) => ({
      key,
      heading: dayHeading(group.date, now, locale),
      chats: group.chats.sort((a, b) => time(b) - time(a)),
    }));
}
