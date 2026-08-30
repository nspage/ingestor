import "dotenv/config";
import type { PendingVideo, ProcessedVideo } from "./config";

/**
 * REST client for the Cloudflare Worker KV API.
 *
 * Used by the local helper (Process, classify, add-channel) to read/write
 * Inbox state. Base URL is WORKER_BASE_URL.
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

/** Mark a video as processed and store its analysis + transcript */
export async function saveProcessedVideo(video: ProcessedVideo): Promise<void> {
  await workerFetch("/api/videos/processed", {
    method: "POST",
    body: JSON.stringify(video),
  });
}

export async function saveFailedVideo(entry: any): Promise<void> {
  await workerFetch(`/api/videos/failed`, {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

// ──────────────────────────────────────────────
// Costs
// ──────────────────────────────────────────────

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

/** KV `tracked_channels` only. Empty KV means nothing is tracked — never merge a hardcoded list. */
export async function getAllChannels(): Promise<ChannelConfig[]> {
  const res = await workerFetch("/api/channels");
  return res.json();
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

/** Save the global categorization prompt and model */
export async function saveCategorisationPrompt(prompt: string, model?: string): Promise<void> {
  await workerFetch("/api/categorisation-prompt", {
    method: "POST",
    body: JSON.stringify({ prompt, model: model || "" }),
  });
}
