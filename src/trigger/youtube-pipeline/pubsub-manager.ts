import "dotenv/config";
import { PUBSUB_HUB_URL, YOUTUBE_FEED_URL, PUBSUB_LEASE_SECONDS } from "./config";

/**
 * Subscribe to a single channel (e.g. when added from the extension)
 */
export async function subscribeSingleChannel(channelId: string): Promise<boolean> {
  const callbackUrl = process.env.PUBSUB_CALLBACK_URL;
  if (!callbackUrl) {
    throw new Error("PUBSUB_CALLBACK_URL missing in .env");
  }

  const topicUrl = YOUTUBE_FEED_URL(channelId);
  console.log(`Subscribing to single channel ${channelId}...`);

  try {
    const response = await fetch(PUBSUB_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": topicUrl,
        "hub.callback": callbackUrl,
        "hub.verify": "async",
        "hub.lease_seconds": String(PUBSUB_LEASE_SECONDS),
      }).toString(),
    });

    if (response.status === 202 || response.status === 204) {
      console.log(`  ✅ Subscription accepted for ${channelId}`);
      return true;
    } else {
      const body = await response.text();
      console.warn(`  ⚠️ Unexpected status ${response.status} for ${channelId}: ${body}`);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Failed to subscribe ${channelId}:`, error);
    return false;
  }
}

export async function unsubscribeSingleChannel(channelId: string): Promise<boolean> {
  const callbackUrl = process.env.PUBSUB_CALLBACK_URL;
  if (!callbackUrl) {
    console.warn("PUBSUB_CALLBACK_URL missing; cannot unsubscribe", channelId);
    return false;
  }

  const topicUrl = YOUTUBE_FEED_URL(channelId);
  console.log(`Unsubscribing from channel ${channelId}...`);

  try {
    const response = await fetch(PUBSUB_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "unsubscribe",
        "hub.topic": topicUrl,
        "hub.callback": callbackUrl,
        "hub.verify": "async",
      }).toString(),
    });

    if (response.status === 202 || response.status === 204) {
      console.log(`  ✅ Unsubscribe accepted for ${channelId}`);
      return true;
    }
    const body = await response.text();
    console.warn(`  ⚠️ Unsubscribe status ${response.status} for ${channelId}: ${body}`);
    return false;
  } catch (error) {
    console.error(`  ❌ Failed to unsubscribe ${channelId}:`, error);
    return false;
  }
}
