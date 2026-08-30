/** Keep in sync with worker/src/queue.ts. worker/test/inbox-rules.test.ts checks the match. */

export const MIN_PENDING_SECONDS = 180;

export const PLACEHOLDER_CHANNEL_NAMES = [
  "",
  "unknown",
  "unknown channel",
  "visit source",
  "youtube video feed",
  "youtube",
  "untitled",
];

export function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function isPlaceholderChannelName(name) {
  const trimmed = decodeHtmlEntities(String(name || "")).trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_CHANNEL_NAMES.includes(trimmed.toLowerCase())) return true;
  if (/^channel-\d+$/i.test(trimmed)) return true;
  return false;
}
