import "dotenv/config";
import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { type PendingVideo } from "./config";
import { addPendingVideo, isVideoProcessed, getAllChannels } from "./kv-client";
import { isPlaceholderChannelName } from "../utils";

/**
 * Ingest a new video notification from YouTube PubSubHubbub.
 *
 * The Cloudflare Worker parses the Atom XML and forwards the extracted
 * fields to this task. We check for duplicates, resolve the channel
 * category, and add to the pending queue.
 */
export const ingestVideo = schemaTask({
  id: "yt-ingest-video",
  retry: { maxAttempts: 3 },
  schema: z.object({
    videoId: z.string().min(1),
    title: z.string(),
    channelId: z.string().min(1),
    channelName: z.string().default("Unknown Channel"),
    publishedAt: z.string(),
  }),
  run: async (payload) => {
    const { videoId, title: payloadTitle, channelId, channelName, publishedAt } = payload;

    console.log(`Ingesting video: "${payloadTitle}" (${videoId}) from ${channelName}`);

    // Check if already processed
    const alreadyDone = await isVideoProcessed(videoId);
    if (alreadyDone) {
      console.log(`  ⏭ Already processed, skipping.`);
      return { action: "skipped", reason: "already_processed", videoId };
    }

    // Fetch extra metadata from YouTube Data API to fix the "YouTube video feed" title bug
    // and get duration/description.
    let finalTitle = payloadTitle;
    let duration = "0:00";
    let description = "";

    try {
      const apiKey = process.env.GOOGLE_API_KEY;
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails&key=${apiKey}`
      );
      const data: any = await res.json();
      const videoItem = data.items?.[0];

      if (videoItem) {
        // Fix the title bug: prioritize API title over payload title
        finalTitle = videoItem.snippet.title;
        description = videoItem.snippet.description || "";
        
        // Parse ISO 8601 duration (PT10M2S -> 10:02)
        duration = parseISO8601Duration(videoItem.contentDetails.duration);
        const seconds = isoToSeconds(videoItem.contentDetails.duration);
        if (seconds != null && seconds < 180) {
          console.log(`  ⏭ Short (${duration}), not adding to pending.`);
          return { action: "skipped", reason: "short", videoId, duration };
        }
        
        console.log(`  ✨ Fetched metadata: "${finalTitle}" [${duration}]`);
      }
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch YouTube metadata:`, err);
    }

    const channels = await getAllChannels();
    const channelConfig = channels.find((c) => c.id === channelId);
    if (!channelConfig) {
      console.log(`  ⏭ Untracked channel ${channelId}, not adding to pending.`);
      return { action: "skipped", reason: "untracked", videoId, channelId };
    }
    const category = channelConfig.category;
    const resolvedName = isPlaceholderChannelName(channelConfig.name)
      ? channelName
      : channelConfig.name;

    const video: PendingVideo = {
      videoId,
      title: finalTitle,
      channelId: channelConfig.id,
      channelName: resolvedName,
      category,
      publishedAt,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      addedAt: new Date().toISOString(),
      duration,
      description: description.slice(0, 300), // Keep a snippet
    };

    await addPendingVideo({ ...video, source: "ingest" } as PendingVideo);

    console.log(`  ✅ Added to pending queue (category: ${category})`);

    return { action: "queued", videoId, category, title: finalTitle };
  },
});

/**
 * Converts ISO 8601 duration (PT1H2M3S) to human format (1:02:03)
 */
function isoToSeconds(duration: string): number | null {
  const matches = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!matches) return null;
  return (Number(matches[1] || 0) * 3600) + (Number(matches[2] || 0) * 60) + Number(matches[3] || 0);
}

function parseISO8601Duration(duration: string): string {
  const matches = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!matches) return "0:00";
  
  const parts = [
    matches[1], // hours
    matches[2] || "0", // minutes
    matches[3] || "0", // seconds
  ];
  
  // Format as HH:MM:SS or MM:SS
  const filtered = parts.map((p, i) => {
    if (i === 0 && !p) return null; // Skip hours if 0
    return p.padStart(2, "0");
  }).filter(Boolean) as string[];

  // If only minutes/seconds and minutes < 10, remove leading 0 for minutes
  if (filtered.length === 2 && filtered[0].startsWith("0")) {
    filtered[0] = filtered[0].slice(1);
  }

  return filtered.join(":");
}
