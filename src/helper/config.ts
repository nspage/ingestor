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
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

/** Default text model for analysis. Bare Gemini ids are normalized to `google/…` at call time. */
export const GEMINI_MODEL = "gemini-3.1-flash-lite";

/** PubSubHubbub lease duration in seconds (5 days) */
export const PUBSUB_LEASE_SECONDS = 432_000;

/** Skip auto-ingest under this length unless the channel category allows Shorts. */
export {
  MIN_PENDING_SECONDS,
  SHORT_TEXT_CATEGORY,
  categoryAllowsShorts,
} from "../../worker/src/queue";

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

/** Per-category multimodal settings. Written by the extension settings UI, read by the locate pass. */
export interface CategoryVisualAssets {
  enabled: boolean;
  /** Closed list — the locate pass only returns these */
  kinds: string[];
  model: string;
  /** HIGH costs 4x tokens per frame; only worth it for OCR-heavy kinds (slides, code) */
  mediaResolution: "default" | "high";
  /** v1 supports "index" only — markdown reconstructions, no stills; "stills" is future work */
  materialize: "index" | "stills";
}

/**
 * One unique on-screen object (slide, diagram, UI, code, chart), reconstructed as markdown.
 * Camera motion on the same object (zoom/pan/highlight) is the SAME asset; the model watches
 * the whole sequence and rebuilds the full object. Never holds image bytes.
 */
export interface VisualAsset {
  /** "MM:SS" or "H:MM:SS" — canonical/overview timestamp (first moment the object is fully readable) */
  t: string;
  /** Optional end of the sequence covering this object */
  tEnd?: string;
  type: string;
  title: string;
  /** Markdown reconstruction (table, bullets, code block, field list, diagram map). Required. */
  reconstruction: string;
  /** "full" when the model could read every region on screen, "partial" when a region was never shown legibly */
  completeness?: "full" | "partial";
  confidence?: number;
}

export interface ProcessedVideo extends PendingVideo {
  transcript: string;
  cues?: TranscriptCue[];
  analysis: string; // markdown
  processedAt: string;
  /** Which writer produced the analysis: helper Process or Gemini Web import */
  analysisSource?: "helper" | "gemini-web";
  descriptionBlock?: string;
  descriptionStatus?: "draft" | "added" | "dismissed";
  assets?: VisualAsset[];
  /** Why the visual pass did not run or returned nothing */
  visualStatus?: "skipped" | "failed" | "empty";
  /** Human-readable detail for skipped/failed (shown in the note) */
  visualNote?: string;
}
