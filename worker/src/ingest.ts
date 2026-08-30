import {
  addPending,
  isTrackedChannel,
  readChannels,
  readDiscardedIds,
  serialize,
} from "./store";
import {
  MIN_PENDING_SECONDS,
  categoryAllowsShorts,
  decodeHtmlEntities,
  findTrackedChannel,
  isPlaceholderChannelName,
} from "./queue";

export type IngestEnv = {
  YT_KV: KVNamespace;
  GOOGLE_API_KEY?: string;
  PUBSUB_CALLBACK_URL?: string;
};

export type FeedEntry = {
  videoId: string;
  channelId: string;
  title: string;
  channelName: string;
  publishedAt: string;
};

const PUBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const PUBSUB_LEASE_SECONDS = 432_000;
const KV_PROCESSED_PREFIX = "processed:";
const KV_CATEGORIES = "categories";

function isoDurationToSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

function formatClock(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function fetchVideoMeta(
  videoId: string,
  apiKey?: string
): Promise<{ seconds: number | null; duration?: string; title?: string }> {
  if (!apiKey) return { seconds: null };
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=contentDetails,snippet&key=${apiKey}`
    );
    if (!res.ok) return { seconds: null };
    const data: any = await res.json();
    const item = data.items?.[0];
    if (!item) return { seconds: null };
    const seconds = isoDurationToSeconds(item.contentDetails?.duration);
    return {
      seconds,
      duration: seconds != null ? formatClock(seconds) : undefined,
      title: item.snippet?.title,
    };
  } catch {
    return { seconds: null };
  }
}

export async function resolveOembed(videoId: string): Promise<{ title?: string; channelName?: string } | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const title = decodeHtmlEntities(String(data.title || "")).trim();
    const channelName = decodeHtmlEntities(String(data.author_name || "")).trim();
    return {
      title: title && !isPlaceholderChannelName(title) ? title : undefined,
      channelName: channelName && !isPlaceholderChannelName(channelName) ? channelName : undefined,
    };
  } catch {
    return null;
  }
}

export function extractXmlTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

export function extractEntryXmlTag(xml: string, tag: string): string | null {
  const start = xml.search(/<entry[\s>]/i);
  if (start < 0) return null;
  return extractXmlTag(xml.slice(start), tag);
}

export function parseFeedEntries(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const re = /<entry[\s>][\s\S]*?<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const block = match[0];
    const videoId = extractXmlTag(block, "yt:videoId");
    const channelId = extractXmlTag(block, "yt:channelId");
    if (!videoId || !channelId) continue;
    entries.push({
      videoId,
      channelId,
      title: extractXmlTag(block, "title") || "",
      channelName: extractXmlTag(block, "name") || "",
      publishedAt: extractXmlTag(block, "published") || new Date().toISOString(),
    });
  }
  return entries;
}

async function readCategories(kv: KVNamespace): Promise<any[]> {
  const raw = await kv.get(KV_CATEGORIES);
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function ingestNotification(
  env: IngestEnv,
  entry: FeedEntry,
  source: "ingest" | "poll" = "ingest"
): Promise<{ action: string; videoId: string; reason?: string }> {
  const { videoId, channelId } = entry;
  const channels = await readChannels(env.YT_KV);
  const matchedChannel = findTrackedChannel(channelId, channels);
  if (!matchedChannel || !(await isTrackedChannel(env.YT_KV, channelId))) {
    return { action: "skipped", videoId, reason: "untracked" };
  }

  const discarded = await readDiscardedIds(env.YT_KV);
  if (discarded.has(videoId)) {
    return { action: "skipped", videoId, reason: "discarded" };
  }

  const existing = await env.YT_KV.get(`${KV_PROCESSED_PREFIX}${videoId}`);
  if (existing) {
    return { action: "skipped", videoId, reason: "processed" };
  }

  const categories = await readCategories(env.YT_KV);
  const allowShorts = categoryAllowsShorts(matchedChannel.category, categories);
  const meta = await fetchVideoMeta(videoId, env.GOOGLE_API_KEY);
  if (!allowShorts && meta.seconds != null && meta.seconds < MIN_PENDING_SECONDS) {
    return { action: "skipped", videoId, reason: "short" };
  }

  const oembed = (isPlaceholderChannelName(entry.channelName) || isPlaceholderChannelName(entry.title) || !entry.title)
    ? await resolveOembed(videoId)
    : null;

  const kvName = decodeHtmlEntities(String(matchedChannel.name || "")).trim();
  const feedName = decodeHtmlEntities(entry.channelName || "").trim();
  const oembedName = oembed?.channelName || "";
  const resolvedName = !isPlaceholderChannelName(kvName)
    ? kvName
    : (!isPlaceholderChannelName(oembedName) ? oembedName
      : (!isPlaceholderChannelName(feedName) ? feedName : ""));

  const result = await serialize(() => addPending(env.YT_KV, {
    videoId,
    title: meta.title || oembed?.title || entry.title || "Untitled",
    channelId: matchedChannel.id,
    channelName: resolvedName,
    category: matchedChannel.category,
    publishedAt: entry.publishedAt || new Date().toISOString(),
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    addedAt: new Date().toISOString(),
    duration: meta.duration,
    source,
  } as any));

  if (!result.added) {
    return { action: "skipped", videoId, reason: result.skipped || "not_added" };
  }
  return { action: "queued", videoId };
}

export async function subscribePubSub(channelId: string, callbackUrl: string): Promise<void> {
  const topic = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const response = await fetch(PUBSUB_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": topic,
        "hub.callback": callbackUrl,
        "hub.verify": "async",
        "hub.lease_seconds": String(PUBSUB_LEASE_SECONDS),
      }).toString(),
    });
    if (response.status !== 202 && response.status !== 204) {
      console.warn(`Subscribe ${channelId} status ${response.status}: ${await response.text()}`);
    }
  } catch (err) {
    console.warn(`Subscribe failed for ${channelId}:`, err);
  }
}

export async function pollChannelFeed(env: IngestEnv, channelId: string): Promise<number> {
  const topic = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(topic);
  if (!res.ok) {
    console.warn(`RSS ${channelId} status ${res.status}`);
    return 0;
  }
  const xml = await res.text();
  const entries = parseFeedEntries(xml);
  let queued = 0;
  for (const entry of entries) {
    const result = await ingestNotification(env, entry, "poll");
    if (result.action === "queued") queued += 1;
  }
  return queued;
}

export async function runScheduledIngest(env: IngestEnv): Promise<{ channels: number; queued: number }> {
  const channels = await readChannels(env.YT_KV);
  let queued = 0;
  const origin = (env.PUBSUB_CALLBACK_URL || "").replace(/\/youtube\/pubsub\/?$/, "");
  const callback = env.PUBSUB_CALLBACK_URL || (origin ? `${origin}/youtube/pubsub` : "");

  for (const ch of channels) {
    if (!ch.id) continue;
    try {
      queued += await pollChannelFeed(env, ch.id);
    } catch (err) {
      console.warn(`Poll failed for ${ch.id}:`, err);
    }
    if (callback) {
      try {
        await subscribePubSub(ch.id, callback);
      } catch (err) {
        console.warn(`Resubscribe failed for ${ch.id}:`, err);
      }
    }
  }
  console.log(`Scheduled ingest: ${channels.length} channels, ${queued} queued`);
  return { channels: channels.length, queued };
}
