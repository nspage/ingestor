import { config } from "dotenv";
config({ override: true });
import { YoutubeTranscript } from 'youtube-transcript';

// ──────────────────────────────────────────────
// Telegram Utilities
// ──────────────────────────────────────────────

/**
 * Send a document (file) to Telegram.
 */
export async function sendTelegramDocument(
  filename: string,
  content: string,
  caption?: string
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { ok: false, error: "Telegram credentials missing" };
  }

  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("caption", caption || "");
    formData.append("parse_mode", "HTML");
    
    const blob = new Blob([content], { type: "text/markdown" });
    formData.append("document", blob, filename);

    const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const data: any = await response.json();
      console.error("Telegram Document Error:", data);
      return { ok: false, error: data.description || `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error sending Telegram document:", error);
    return { ok: false, error: message };
  }
}

// ──────────────────────────────────────────────
// YouTube Utilities
// ──────────────────────────────────────────────

function decodeHtmlEntities(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function isPlaceholderChannelName(name: string | undefined | null): boolean {
  const trimmed = decodeHtmlEntities(String(name || "")).trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (["unknown", "unknown channel", "visit source", "youtube video feed", "youtube", "untitled"].includes(lower)) return true;
  return /^channel-\d+$/i.test(trimmed);
}

export type VideoIdentity = {
  videoId: string;
  title?: string;
  channelName?: string;
  authorUrl?: string;
};

/** Title + channel from YouTube oEmbed — no Data API key. Works for Shorts. */
export async function resolveVideoIdentity(videoId: string): Promise<VideoIdentity | null> {
  const id = String(videoId || "").trim();
  if (!id) return null;
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: any = await res.json();
    const title = usableName(data.title) || (typeof data.title === "string" ? data.title.trim() : undefined);
    const channelName = usableName(data.author_name) || undefined;
    const authorUrl = typeof data.author_url === "string" ? data.author_url : undefined;
    return { videoId: id, title, channelName, authorUrl };
  } catch {
    return null;
  }
}

function extractChannelIdFromUrl(url: string): string | null {
  const match = url.match(/\/channel\/(UC[\w-]+)/);
  return match ? match[1] : null;
}

function usableName(name: string | undefined | null): string | null {
  const decoded = decodeHtmlEntities(String(name || "")).replace(/\s+-\s+YouTube$/i, "").trim();
  if (isPlaceholderChannelName(decoded)) return null;
  return decoded;
}

async function channelSnippet(channelId: string): Promise<{ id: string; name: string } | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const id = channelId;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(id)}&key=${apiKey}`);
  if (!res.ok) return null;
  const data: any = await res.json();
  const item = data.items?.[0];
  const name = usableName(item?.snippet?.title);
  if (!item?.id || !name) return null;
  return { id: item.id, name };
}

async function channelFromRss(channelId: string): Promise<{ id: string; name: string } | null> {
  const id = channelId;
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const xml = await res.text();
  const name = usableName(xml.match(/<author>\s*<name>([^<]+)<\/name>/i)?.[1] || xml.match(/<title>([^<]+)<\/title>/i)?.[1]);
  if (!name) return null;
  return { id, name };
}

/**
 * Resolve YouTube Handle to Base Channel ID by parsing HTML
 */
export async function resolveChannelInfo(url: string): Promise<{ id: string; name: string } | null> {
  try {
    const fromUrl = extractChannelIdFromUrl(url);
    if (fromUrl) {
      const fromApi = await channelSnippet(fromUrl).catch(() => null);
      if (fromApi) return fromApi;
      const fromRss = await channelFromRss(fromUrl).catch(() => null);
      if (fromRss) return fromRss;
    }

    const targetUrl = url.includes("youtube.com")
      ? (url.includes("?") ? `${url}&ucbcb=1` : `${url}?ucbcb=1`)
      : url;

    console.log(`[Utils] Fetching channel HTML from: ${targetUrl}`);

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });

    console.log(`[Utils] Fetch status: ${response.status}`);
    if (!response.ok) return fromUrl ? { id: fromUrl, name: fromUrl } : null;

    const html = await response.text();
    console.log(`[Utils] HTML length: ${html.length}`);

    const idPatterns = [
      /<meta itemprop="channelId" content="(UC[\w-]+)">/,
      /"externalId":"(UC[\w-]+)"/,
      /youtube\.com\/channel\/(UC[\w-]+)/,
      /"channelId":"(UC[\w-]+)"/
    ];

    let channelId: string | null = fromUrl;
    for (const pattern of idPatterns) {
      const match = html.match(pattern);
      if (match) {
        channelId = match[1];
        console.log(`[Utils] Found Channel ID using pattern: ${pattern.source}`);
        break;
      }
    }

    const namePatterns = [
      /<meta property="og:title" content="([^"]+)">/,
      /<meta name="title" content="([^"]+)">/,
    ];

    let channelName: string | null = null;
    for (const pattern of namePatterns) {
      const match = html.match(pattern);
      const name = usableName(match?.[1]);
      if (name) {
        channelName = name;
        break;
      }
    }

    if (channelId) {
      const fromApi = await channelSnippet(channelId).catch(() => null);
      if (fromApi) return fromApi;
      return { id: channelId, name: channelName || channelId };
    }

    console.warn("[Utils] Could not find Channel ID in HTML");
    return null;
  } catch (err) {
    console.error("[Utils] Error resolving channel:", err);
    return null;
  }
}

/**
 * Resolve YouTube Video Duration by parsing HTML
 */
export async function resolveVideoDuration(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });

    if (!response.ok) return null;
    
    const html = await response.text();
    
    const lengthSecondsMatch = html.match(/"lengthSeconds":"(\d+)"/);
    if (lengthSecondsMatch) {
      const totalSeconds = parseInt(lengthSecondsMatch[1], 10);
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      
      if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      }
      return `${m}:${s.toString().padStart(2, '0')}`;
    }
    
    return null;
  } catch (err) {
    console.error("[Utils] Error resolving video duration:", err);
    return null;
  }
}

// ──────────────────────────────────────────────
// Classification Utilities (Phase 1)
// ──────────────────────────────────────────────

/**
 * Get the latest N video IDs for a given channel using the YouTube Data API.
 */
export async function getLatestVideoIds(channelId: string, limit: number = 5): Promise<string[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("[Utils] GOOGLE_API_KEY missing in .env");
    return [];
  }

  // The 'uploads' playlist ID is almost always the channel ID with 'UU' instead of 'UC'
  const uploadsPlaylistId = channelId.startsWith("UC") 
    ? channelId.replace(/^UC/, "UU") 
    : channelId;

  console.log(`[Utils] Fetching latest ${limit} videos for playlist: ${uploadsPlaylistId}`);

  try {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${limit}&key=${apiKey}`;
    const response = await fetch(url);
    const data: any = await response.json();

    if (!response.ok) {
      console.error("[Utils] YouTube API Error:", data.error?.message || response.statusText);
      return [];
    }

    const videoIds = data.items?.map((item: any) => item.snippet.resourceId.videoId) || [];
    console.log(`[Utils] Found ${videoIds.length} video(s)`);
    return videoIds;
  } catch (err) {
    console.error("[Utils] Error fetching latest video IDs:", err);
    return [];
  }
}

/** youtube-transcript uses ms (srv3) or seconds (classic XML). Persist ms. */
export function normalizeCues(segments: Array<{ text: string; offset: number; duration: number }>) {
  return segments.map((s) => {
    const looksMs =
      Number.isInteger(s.offset) &&
      Number.isInteger(s.duration) &&
      (s.duration >= 100 || s.offset >= 1000);
    return {
      text: s.text,
      offset: looksMs ? s.offset : Math.round(s.offset * 1000),
      duration: looksMs ? s.duration : Math.round(s.duration * 1000),
    };
  });
}

export async function fetchTranscriptCues(videoId: string) {
  let segments;
  try {
    segments = await YoutubeTranscript.fetchTranscript(videoId);
  } catch {
    segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
  }
  return normalizeCues(segments);
}

/**
 * Fetch a text sample of a video transcript.
 */
export async function getTranscriptSample(videoId: string, maxChars: number = 5000): Promise<string> {
  console.log(`[Utils] Fetching transcript sample for: ${videoId}`);
  try {
    const cues = await fetchTranscriptCues(videoId);
    const fullText = cues.map((s) => s.text).join(" ");
    return fullText.slice(0, maxChars);
  } catch (err) {
    console.warn(`[Utils] Could not fetch transcript for ${videoId}:`, err instanceof Error ? err.message : String(err));
    return "";
  }
}

export async function fetchVideoDescription(videoId: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || !videoId) return "";
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}&part=snippet&key=${apiKey}`
    );
    if (!res.ok) return "";
    const data: any = await res.json();
    return String(data.items?.[0]?.snippet?.description ?? "");
  } catch (err) {
    console.warn("[Utils] Could not fetch video description:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

