export type PendingVideo = {
  videoId: string;
  title?: string;
  channelId?: string;
  channelName?: string;
  category?: string;
  publishedAt?: string;
  videoUrl?: string;
  addedAt?: string;
  duration?: string;
  description?: string;
  needsCategory?: boolean;
  [key: string]: unknown;
};

export type TrackedChannel = {
  id: string;
  name: string;
  category: string;
  [key: string]: unknown;
};

export const PLACEHOLDER_CHANNEL_NAMES = [
  "",
  "unknown",
  "unknown channel",
  "visit source",
  "youtube video feed",
  "youtube",
  "untitled",
];

export const SHORT_TEXT_CATEGORY = "short text extract";
export const MIN_PENDING_SECONDS = 180;

export function categoryAllowsShorts(
  category: string | undefined,
  categories: Array<{ name?: string; visualAssets?: { enabled?: boolean; kinds?: string[] } }> = []
): boolean {
  const name = String(category || "").trim().toLowerCase();
  if (name === SHORT_TEXT_CATEGORY) return true;
  const cat = categories.find((c) => String(c.name || "").trim().toLowerCase() === name);
  const kinds = cat?.visualAssets?.kinds || [];
  return !!(cat?.visualAssets?.enabled && kinds.includes("on_screen_text"));
}

export function decodeHtmlEntities(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function canonicalChannelId(id: string | undefined | null): string {
  return String(id || "").trim();
}

export function isPlaceholderChannelName(name: string | undefined | null): boolean {
  const trimmed = decodeHtmlEntities(String(name || "")).trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_CHANNEL_NAMES.includes(trimmed.toLowerCase())) return true;
  if (/^channel-\d+$/i.test(trimmed)) return true;
  return false;
}

/** Display name from the KV record only — never from a hardcoded channel list. */
export function displayChannelName(channel: { id?: string; name?: string }): string {
  const id = canonicalChannelId(channel.id);
  const name = decodeHtmlEntities(String(channel.name || "")).trim();
  if (!isPlaceholderChannelName(name)) return name;
  return id;
}

export function mergePending(
  fromList: PendingVideo[],
  fromKeys: PendingVideo[],
  discardedIds: Iterable<string>
): PendingVideo[] {
  const discarded = new Set([...discardedIds].filter(Boolean));
  const byId = new Map<string, PendingVideo>();
  for (const video of fromList || []) {
    if (!video?.videoId || discarded.has(video.videoId)) continue;
    byId.set(video.videoId, video);
  }
  for (const video of fromKeys || []) {
    if (!video?.videoId || discarded.has(video.videoId)) continue;
    byId.set(video.videoId, video);
  }
  return Array.from(byId.values());
}

export function upsertPending(list: PendingVideo[], video: PendingVideo): PendingVideo[] {
  if (!video?.videoId) return list.slice();
  const next = list.filter((v) => v.videoId !== video.videoId);
  next.push(video);
  return next;
}

export function removePendingIds(list: PendingVideo[], videoIds: Iterable<string>): PendingVideo[] {
  const ids = new Set([...videoIds].filter(Boolean));
  return list.filter((v) => !ids.has(v.videoId));
}

export function applyPatches(list: PendingVideo[], patches: PendingVideo[]): PendingVideo[] {
  if (!patches?.length) return list.slice();
  const byId = new Map(patches.filter((p) => p?.videoId).map((p) => [p.videoId, p]));
  return list.map((video) => {
    const patch = byId.get(video.videoId);
    return patch ? { ...video, ...patch, videoId: video.videoId } : video;
  });
}

export function shouldIngestChannel(
  channelId: string,
  tracked: Array<{ id?: string }>,
  untrackedIds: Iterable<string> = []
): boolean {
  const id = canonicalChannelId(channelId);
  const blocked = new Set([...untrackedIds].map(canonicalChannelId).filter(Boolean));
  if (!id || blocked.has(id)) return false;
  return tracked.some((ch) => canonicalChannelId(ch.id) === id);
}

export function findTrackedChannel(
  channelId: string,
  tracked: TrackedChannel[]
): TrackedChannel | undefined {
  const id = canonicalChannelId(channelId);
  return tracked.find((ch) => canonicalChannelId(ch.id) === id);
}

export function normalizeChannels(channels: TrackedChannel[]): TrackedChannel[] {
  const byId = new Map<string, TrackedChannel>();
  for (const raw of channels || []) {
    const id = canonicalChannelId(raw?.id);
    if (!id) continue;
    const prev = byId.get(id);
    const name = decodeHtmlEntities(String(raw.name || prev?.name || "")).trim();
    byId.set(id, {
      ...prev,
      ...raw,
      id,
      name,
      category: raw.category || prev?.category || "",
    });
  }
  return Array.from(byId.values());
}

export function removeTrackedIds(
  channels: TrackedChannel[],
  channelId: string
): TrackedChannel[] {
  const id = canonicalChannelId(channelId);
  return channels.filter((ch) => canonicalChannelId(ch.id) !== id);
}
