/** Where the chat list's chosen width is saved. */
export const sidebarWidthKey = "bakery-chat-sidebar-width";
/** The narrowest the chat list gets, which still fits its New chat and Group by controls. */
export const sidebarMin = 180;
/** The width before the operator picks one. */
export const sidebarDefault = 224;
/** Room always left for the message pane beside the chat list. */
export const messagePaneMin = 360;
/** The room the divider takes beside the list: its 6px width less its 1px overlap. */
export const dividerWidth = 5;
/** How far one arrow key moves the divider, and one with Shift held. */
export const sidebarStep = 16;
export const sidebarBigStep = 64;

/** The saved width, or the default when nothing usable is saved. */
export function readSidebarWidth(stored: string | null) {
  const width = Number(stored);
  return stored && Number.isFinite(width) && width > 0
    ? Math.round(width)
    : sidebarDefault;
}

/**
 * The range the chat list can take: at most the width that shows its longest label on one line, and never so wide
 * that the message pane drops below its minimum. The minimum wins when there is no room for both. A content width
 * of null (not measured yet) leaves only the viewport limit.
 */
export function sidebarBounds(
  contentWidth: number | null,
  containerWidth: number | null,
) {
  let max = Infinity;
  if (contentWidth !== null) max = Math.min(max, Math.ceil(contentWidth) + 1);
  if (containerWidth !== null)
    max = Math.min(
      max,
      Math.floor(containerWidth - messagePaneMin - dividerWidth),
    );
  return { min: sidebarMin, max: Math.max(sidebarMin, max) };
}

/** `width` kept within `bounds`, in whole pixels. */
export const clampSidebar = (
  width: number,
  bounds: { min: number; max: number },
) => Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));

/**
 * The width a chat row needs to show its label on one line: the row as laid out, less the label's box, plus the
 * label's text at its own width and padding. The text width must be measured from the text itself, since the
 * label's box is stretched to fill the row and so never reads narrower than the row gives it. The time, unread
 * badge and delete control keep their own widths.
 */
export const rowNaturalWidth = (row: {
  rowWidth: number;
  labelClientWidth: number;
  textWidth: number;
  labelPadding: number;
}) => row.rowWidth - row.labelClientWidth + row.textWidth + row.labelPadding;
