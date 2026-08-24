import "dotenv/config";

// ──────────────────────────────────────────────
// YouTube Channel Configuration
// ──────────────────────────────────────────────

/**
 * Content categories — determines which structured prompt template
 * is used during Gemini analysis. Category-specific prompts will be
 * defined in a later phase; for now they all share the default template.
 */
export type ContentCategory = string;

export interface ChannelConfig {
  /** YouTube channel ID (from the /channel/ URL) */
  id: string;
  /** Human-readable name (resolved after first notification, or set manually) */
  name: string;
  /** Content category for analysis prompt selection */
  category: ContentCategory;
}

/**
 * Tracked channels live only in Cloudflare KV (`tracked_channels`).
 * Do not keep a hardcoded allowlist here — an empty KV list means nothing is tracked.
 */

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

/** PubSubHubbub hub URL for YouTube */
export const PUBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

/** YouTube Atom feed template — replace CHANNEL_ID */
export const YOUTUBE_FEED_URL = (channelId: string) =>
  `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;

/** Gemini model for analysis */
export const GEMINI_MODEL = "gemini-3.1-flash-lite";

/** IANA timezone for the daily digest cron. Default UTC. */
export const TIMEZONE = process.env.TIMEZONE || "UTC";

/** Daily digest recipient. Empty means the digest is skipped. */
export const EMAIL_TO = process.env.EMAIL_TO || "";

/** PubSubHubbub lease duration in seconds (5 days) */
export const PUBSUB_LEASE_SECONDS = 432_000;

// ──────────────────────────────────────────────
// Video types
// ──────────────────────────────────────────────

export interface PendingVideo {
  videoId: string;
  title: string;
  channelId: string;
  channelName: string;
  category: ContentCategory;
  publishedAt: string;
  videoUrl: string;
  addedAt: string; // ISO timestamp when we received the notification
  duration?: string; // e.g. "12:05"
  description?: string; // brief snippet
  /** Manual YouTube pick — shown in the Pending highlight block until a category is set */
  needsCategory?: boolean;
}

export interface TranscriptCue {
  text: string;
  offset: number; // milliseconds from start
  duration: number; // milliseconds
}

export interface ProcessedVideo extends PendingVideo {
  transcript: string;
  cues?: TranscriptCue[];
  analysis: string; // markdown
  processedAt: string;
  descriptionBlock?: string;
  descriptionStatus?: "draft" | "added" | "dismissed";
}
