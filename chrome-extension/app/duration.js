export const MIN_PENDING_SECONDS = 180;

export function durationLabelToSeconds(label) {
  if (!label) return null;
  const parts = String(label).replace(/[\[\]]/g, "").trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function isShortVideo(video) {
  const seconds = durationLabelToSeconds(video && video.duration);
  return seconds != null && seconds < MIN_PENDING_SECONDS;
}

export function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return `Today, ${timeStr}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${timeStr}`;
}

export function thumbUrl(videoId) {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}
