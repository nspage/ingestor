import "dotenv/config";
import type { PendingVideo, ProcessedVideo } from "./config";

/**
 * REST client for the Cloudflare Worker KV API.
 *
 * The Worker exposes a simple CRUD API on top of Cloudflare KV.
 * This client is used by Trigger.dev tasks to read/write video state.
 *
 * Base URL is set via WORKER_BASE_URL environment variable.
 */

function getBaseUrl(): string {
  const url = process.env.WORKER_BASE_URL;
  if (!url) throw new Error("WORKER_BASE_URL missing in .env");
  return url.replace(/\/$/, "");
}

function getApiSecret(): string {
  const secret = process.env.WORKER_API_SECRET;
  if (!secret) throw new Error("WORKER_API_SECRET missing in .env");
  return secret;
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiSecret()}`,
    ...(init?.headers as Record<string, string> || {}),
  };

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Worker API error ${response.status}: ${text}`);
  }
  return response;
}

// ──────────────────────────────────────────────
// Pending Videos
// ──────────────────────────────────────────────

/** Get all pending (un-approved) videos */
export async function getPendingVideos(): Promise<PendingVideo[]> {
  const res = await workerFetch("/api/videos/pending");
  return res.json();
}

/** Add a video to the pending queue */
export async function addPendingVideo(video: PendingVideo): Promise<void> {
  await workerFetch("/api/videos/pending", {
    method: "POST",
    body: JSON.stringify(video),
  });
}

/** Remove specific videos from the pending queue (after approval/skip) */
export async function removePendingVideos(videoIds: string[]): Promise<void> {
  await workerFetch("/api/videos/pending", {
    method: "DELETE",
    body: JSON.stringify({ videoIds }),
  });
}

/** Patch fields on existing pending videos. Does not replace the queue or resurrect discarded ids. */
export async function updatePendingVideos(pending: PendingVideo[]): Promise<void> {
  await workerFetch("/api/videos/pending", {
    method: "PATCH",
    body: JSON.stringify({ videos: pending }),
  });
}

// ──────────────────────────────────────────────
// Processed Videos
// ──────────────────────────────────────────────

/** Check if a video has already been processed */
export async function isVideoProcessed(videoId: string): Promise<boolean> {
  const res = await workerFetch(`/api/videos/processed/${videoId}`);
  const data: any = await res.json();
  return data.exists === true;
}

/** Mark a video as processed and store its analysis + transcript */
export async function saveProcessedVideo(video: ProcessedVideo): Promise<void> {
  await workerFetch("/api/videos/processed", {
    method: "POST",
    body: JSON.stringify(video),
  });
}

/** Get all analyses produced today (for the daily email) */
export async function getTodaysAnalyses(): Promise<ProcessedVideo[]> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const res = await workerFetch(`/api/videos/analyses?date=${today}`);
  return res.json();
}

/** Get all processed analyses (for History tab) */
export async function getAllAnalyses(): Promise<ProcessedVideo[]> {
  // Pass an empty date or a wildcard approach if worker supports it.
  // Wait, worker searches prefix KV_ANALYSIS_PREFIX + date + ":". 
  // If we pass an empty date to worker, does it fetch everything?
  // Worker: const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  // So worker currently requires a date or defaults to today.
  // Let's modify the worker via another call to support getting all history, or just change the prefix if date is "all".
  const res = await workerFetch(`/api/videos/analyses?date=all`);
  return res.json();
}

export async function getFailedVideos(): Promise<any[]> {
  const res = await workerFetch(`/api/videos/failed`);
  return res.json();
}

export async function saveFailedVideo(entry: any): Promise<void> {
  await workerFetch(`/api/videos/failed`, {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

export async function clearFailedVideo(videoId?: string): Promise<void> {
  await workerFetch(`/api/videos/failed`, {
    method: "DELETE",
    body: JSON.stringify({ videoId }),
  });
}

// ──────────────────────────────────────────────
// Costs
// ──────────────────────────────────────────────

/** Get the accumulated API cost and token usage for a given date (defaults to today) */
export async function getDailyCost(date?: string): Promise<{ date: string; cost: number; tokens: number }> {
  const query = date ? `?date=${date}` : "";
  const res = await workerFetch(`/api/costs/daily${query}`);
  return res.json();
}

/** Increment the daily API cost and token usage */
export async function incrementDailyCost(cost: number, tokens: number, date?: string): Promise<void> {
  const body: any = { cost, tokens };
  if (date) body.date = date;
  await workerFetch("/api/costs/daily", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ──────────────────────────────────────────────
// Channels
// ──────────────────────────────────────────────

import { type ChannelConfig } from "./config";

/** Get the list of all tracked YouTube channels */
export async function getTrackedChannels(): Promise<ChannelConfig[]> {
  const res = await workerFetch("/api/channels");
  return res.json();
}

/** KV `tracked_channels` only. Empty KV means nothing is tracked — never merge a hardcoded list. */
export async function getAllChannels(): Promise<ChannelConfig[]> {
  return getTrackedChannels();
}

/** Overwrite the full list of tracked YouTube channels in KV */
export async function updateAllChannels(channels: ChannelConfig[]): Promise<void> {
  await workerFetch("/api/channels", {
    method: "PUT",
    body: JSON.stringify(channels),
  });
}

/** Add a new YouTube channel to the tracked list */
export async function addTrackedChannel(channel: ChannelConfig): Promise<void> {
  await workerFetch("/api/channels", {
    method: "POST",
    body: JSON.stringify(channel),
  });
}

/** Remove a tracked YouTube channel */
export async function removeTrackedChannel(channelId: string): Promise<void> {
  await workerFetch("/api/channels", {
    method: "DELETE",
    body: JSON.stringify({ channelId }),
  });
}

// ──────────────────────────────────────────────
// Categories
// ──────────────────────────────────────────────

export interface CategoryPrompt {
  name: string;
  prompt: string;
  model?: string;
  visualAssets?: import("./config").CategoryVisualAssets;
}

export async function getCategories(): Promise<CategoryPrompt[]> {
  const res = await workerFetch("/api/categories");
  return res.json();
}

export async function saveCategory(
  name: string,
  prompt: string,
  model?: string,
  visualAssets?: CategoryPrompt["visualAssets"]
): Promise<void> {
  await workerFetch("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name, prompt, model, visualAssets }),
  });
}

export async function deleteCategory(name: string): Promise<void> {
  await workerFetch("/api/categories", {
    method: "DELETE",
    body: JSON.stringify({ name }),
  });
}

export async function renameCategory(oldName: string, newName: string): Promise<void> {
  await workerFetch("/api/categories/rename", {
    method: "POST",
    body: JSON.stringify({ oldName, newName }),
  });
}

// ──────────────────────────────────────────────
// Categorisation Prompt
// ──────────────────────────────────────────────

export interface CategorisationPromptDetails {
  prompt: string;
  model: string;
}

/** Get the global categorization prompt and model details */
export async function getCategorisationPromptDetails(): Promise<CategorisationPromptDetails> {
  const res = await workerFetch("/api/categorisation-prompt");
  const data: any = await res.json();
  return {
    prompt: data.prompt || "",
    model: data.model || ""
  };
}

/** Get the global categorization prompt */
export async function getCategorisationPrompt(): Promise<string> {
  const details = await getCategorisationPromptDetails();
  return details.prompt;
}

/** Save the global categorization prompt and model */
export async function saveCategorisationPrompt(prompt: string, model?: string): Promise<void> {
  await workerFetch("/api/categorisation-prompt", {
    method: "POST",
    body: JSON.stringify({ prompt, model: model || "" }),
  });
}
