import "dotenv/config";
import { getTrackedChannels, updateAllChannels } from "./kv-client";
import { classifyChannel } from "./classify-channel";
import { ChannelConfig } from "./config";

export async function migrateAllChannels() {
    // 1. Fetch current tracked channels from KV (KV is the only list)
    const channels = await getTrackedChannels();
    console.log(`[Migration] Found ${channels.length} dynamic channels to migrate.`);

    if (channels.length === 0) {
      return { status: "skipped", reason: "no_dynamic_channels" };
    }

    console.log(`[Migration] Classifying each channel...`);
    const updatedChannels: ChannelConfig[] = [];

    for (const originalChannel of channels) {
      try {
        const output = await classifyChannel({
          channelId: originalChannel.id,
          channelName: originalChannel.name,
        });
        console.log(`[Migration] Successfully classified: ${originalChannel.name} -> ${output.category}`);
        updatedChannels.push({
          ...originalChannel,
          category: output.category,
        });
      } catch (error) {
        console.error(`[Migration] Failed to classify ${originalChannel.name}:`, error);
        updatedChannels.push(originalChannel);
      }
    }

    console.log(`[Migration] Final updatedChannels count: ${updatedChannels.length}`);

    // 4. Perform a single bulk update to KV
    if (updatedChannels.length > 0) {
      console.log(`[Migration] Performing bulk update to Cloudflare KV for ${updatedChannels.length} channels...`);
      await updateAllChannels(updatedChannels);
      console.log(`[Migration] Successfully updated ${updatedChannels.length} channels in KV.`);
    } else {
      console.warn("[Migration] Warning: No channels were processed. Skipping KV update.");
      return { status: "failed", reason: "no_channels_processed" };
    }

    return { 
      total: channels.length, 
      updated: updatedChannels.length,
      mapping: updatedChannels.map(c => ({ name: c.name, category: c.category }))
    };
}
