import { Hono } from "hono";
import {
  addChannel,
  addPending,
  analysisKey,
  completeInboxNote,
  discardPending,
  patchPending,
  readAnalyses,
  readChannels,
  readPending,
  removeChannel,
  removeFromAnalysisIndex,
  serialize,
  upsertAnalysisIndex,
  upsertPendingList,
  writeChannels,
  KV_PROCESSED_PREFIX,
  KV_TRACKED_CHANNELS,
} from "./store";
import {
  MIN_PENDING_SECONDS,
  categoryAllowsShorts,
  decodeHtmlEntities,
  isPlaceholderChannelName,
} from "./queue";
import {
  extractEntryXmlTag,
  extractXmlTag,
  fetchVideoMeta,
  ingestNotification,
  parseFeedEntries,
  runScheduledIngest,
} from "./ingest";

/**
 * Cloudflare Worker — ingestor Inbox store
 *
 * Public-facing endpoints:
 *  1. /youtube/pubsub  — PubSubHubbub verification (GET) + notification (POST)
 *  2. /api/*           — REST for pending videos, channels, categories, notes
 *  3. scheduled cron   — RSS backfill + PubSub lease renewal
 */

type Env = {
  YT_KV: KVNamespace;
  WORKER_API_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  GOOGLE_API_KEY?: string;
  PUBSUB_CALLBACK_URL?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin") || "";
  if (origin.startsWith("chrome-extension://")) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    c.header("Access-Control-Max-Age", "86400");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// ── Helper: Auth middleware for /api routes ──

function requireAuth(c: any): boolean {
  const auth = c.req.header("Authorization");
  const expected = `Bearer ${c.env.WORKER_API_SECRET}`;
  return auth === expected;
}

// ── KV Key Helpers ──

const KV_DAILY_COST_PREFIX = "cost:";
const KV_CATEGORIES = "categories";
const KV_CATEGORISATION_PROMPT = "categorisation_prompt";
const KV_FAILED = "failed_videos";

const DEFAULT_CATEGORIES = [
  {
    name: "growth",
    model: "gemini-3.1-flash-lite",
    prompt: `Analyze the transcript and provide:\n- Speaker identification with their roles/affiliations\n- Key topics developed in the transcript\nIdentify and categorize the information within the transcript according to the following archetypes. If a category is not present, skip it:\n1. **Mental Models (The 'Why'):** Philosophical shifts or conceptual lenses used to view the problem. \n2. **Frameworks & Systems (The 'Structure'):** Repeatable processes, 2x2 matrices, or step-by-step methodologies developed by the speaker. \n3. **Tactical Tutorials (The 'How'):** Click-by-click or action-by-action instructions. Provide these as a numbered "SOP" (Standard Operating Procedure).\n4. **Deep Dives (The 'Mechanics'):** High-density technical explanations or granular breakdowns of a specific system \n5. **Interview Insights (The 'Nuance'):** If this is an interview, extract the non-obvious wisdom gained from the back-and-forth, including the speaker's personal "war stories."\n6. **Case Studies (The 'Proof'):** Real-world examples cited. Detail the Challenge, the Intervention, and the Result.\n7. **Heuristics & Red Flags (The 'Shortcuts'):** Rules of thumb, "if-this-then-that" shortcuts, and warning signs to watch out for.\n8. **Contrarian Takes (The 'Alpha'):** Ideas mentioned that go against the "common wisdom" of the industry.\n9. **Resource Stack (The 'Tools'):** A list of all software, books, hardware, or third-party services mentioned as essential.`
  },
  {
    name: "ai concepts",
    model: "gemini-3.1-flash-lite",
    prompt: `Analyze the transcript and provide:\n- Speaker identification with their roles/affiliations\n- Key topics developed in the transcript\n- Core frameworks and mental models developed in the transcript (with visual representation instructions if relevant)\n- Case studies with key takeaways\n- Glossary of specialized terms\nIdentify and categorize the information within the transcript according to the following archetypes. If a category is not present, skip it:\n1. **Mental Models (The 'Why'):** Philosophical shifts or conceptual lenses used to view the problem. \n2. **Frameworks & Systems (The 'Structure'):** Repeatable processes, 2x2 matrices, or step-by-step methodologies developed by the speaker. \n3. **Tactical Tutorials (The 'How'):** Click-by-click or action-by-action instructions. Provide these as a numbered "SOP" (Standard Operating Procedure).\n4. **Deep Dives (The 'Mechanics'):** High-density technical explanations or granular breakdowns of a specific system \n5. **Interview Insights (The 'Nuance'):** If this is an interview, extract the non-obvious wisdom gained from the back-and-forth, including the speaker's personal "war stories."\n6. **Case Studies (The 'Proof'):** Real-world examples cited. Detail the Challenge, the Intervention, and the Result.\n7. **Heuristics & Red Flags (The 'Shortcuts'):** Rules of thumb, "if-this-then-that" shortcuts, and warning signs to watch out for.\n8. **Contrarian Takes (The 'Alpha'):** Ideas mentioned that go against the "common wisdom" of the industry.\n9. **Resource Stack (The 'Tools'):** A list of all software, books, hardware, or third-party services mentioned as essential.`
  },
  {
    name: "entrepreneurship",
    model: "gemini-3.1-flash-lite",
    prompt: `Analyze the transcript and provide:\n- Speaker identification with their roles/affiliations\n- Key topics developed in the transcript\n- Glossary of specialized terms\nIdentify and categorize the information within the transcript according to the following archetypes. If a category is not present, skip it:\n1. **Mental Models (The 'Why'):** Philosophical shifts or conceptual lenses used to view the problem. \n2. **Frameworks & Systems (The 'Structure'):** Repeatable processes, 2x2 matrices, or step-by-step methodologies developed by the speaker. \n3. **Tactical Tutorials (The 'How'):** Click-by-click or action-by-action instructions. Provide these as a numbered "SOP" (Standard Operating Procedure).\n4. **Deep Dives (The 'Mechanics'):** High-density technical explanations or granular breakdowns of a specific system \n5. **Interview Insights (The 'Nuance'):** If this is an interview, extract the non-obvious wisdom gained from the back-and-forth, including the speaker's personal "war stories."\n6. **Case Studies (The 'Proof'):** Real-world examples cited. Detail the Challenge, the Intervention, and the Result.\n7. **Heuristics & Red Flags (The 'Shortcuts'):** Rules of thumb, "if-this-then-that" shortcuts, and warning signs to watch out for.\n8. **Contrarian Takes (The 'Alpha'):** Ideas mentioned that go against the "common wisdom" of the industry.\n9. **Resource Stack (The 'Tools'):** A list of all software, books, hardware, or third-party services mentioned as essential.`
  },
  {
    name: "web3 business",
    model: "gemini-3.1-flash-lite",
    prompt: `Analyze the transcript and provide:\n- Speaker identification with their roles/affiliations\n- Key topics developed in the transcript\n- Glossary of specialized terms\nIdentify and categorize the information within the transcript according to the following archetypes. If a category is not present, skip it:\n1. **Mental Models (The 'Why'):** Philosophical shifts or conceptual lenses used to view the problem. \n2. **Frameworks & Systems (The 'Structure'):** Repeatable processes, 2x2 matrices, or step-by-step methodologies developed by the speaker. \n3. **Tactical Tutorials (The 'How'):** Click-by-click or action-by-action instructions. Provide these as a numbered "SOP" (Standard Operating Procedure).\n4. **Deep Dives (The 'Mechanics'):** High-density technical explanations or granular breakdowns of a specific system \n5. **Interview Insights (The 'Nuance'):** If this is an interview, extract the non-obvious wisdom gained from the back-and-forth, including the speaker's personal "war stories."\n6. **Case Studies (The 'Proof'):** Real-world examples cited. Detail the Challenge, the Intervention, and the Result.\n7. **Heuristics & Red Flags (The 'Shortcuts'):** Rules of thumb, "if-this-then-that" shortcuts, and warning signs to watch out for.\n8. **Contrarian Takes (The 'Alpha'):** Ideas mentioned that go against the "common wisdom" of the industry.\n9. **Resource Stack (The 'Tools'):** A list of all software, books, hardware, or third-party services mentioned as essential.`
  },
  {
    name: "short text extract",
    model: "google/gemini-3.1-flash-lite",
    prompt: "Reconstruct every readable on-screen text block from this video in reading order. Prefer the screen over speech. Output markdown a human can paste (prompts, lists, emails, tweets, configs). Skip talking head and UI chrome.",
    visualAssets: {
      enabled: true,
      kinds: ["on_screen_text"],
      model: "google/gemini-3.7-flash",
      mediaResolution: "high",
      materialize: "index",
    },
  },
];

function seedCategories(list: any[]): { list: any[]; changed: boolean } {
  const next = Array.isArray(list) ? list.slice() : [];
  let changed = false;
  if (!next.some((c) => String(c?.name || "").toLowerCase() === "short text extract")) {
    const seed = DEFAULT_CATEGORIES.find((c) => c.name === "short text extract");
    if (seed) {
      next.push(seed);
      changed = true;
    }
  }
  return { list: next, changed };
}

// ────────────────────────────────────────
// 1. PubSubHubbub Endpoints
// ────────────────────────────────────────

/** GET /youtube/pubsub — Hub verification challenge */
app.get("/youtube/pubsub", (c) => {
  const challenge = c.req.query("hub.challenge");
  const mode = c.req.query("hub.mode");
  const topic = c.req.query("hub.topic");

  console.log(`PubSubHubbub verification: mode=${mode} topic=${topic}`);

  if (challenge) {
    return c.text(challenge, 200);
  }
  return c.text("Missing challenge", 400);
});

/** POST /youtube/pubsub — Receive new video notification (Atom XML) */
app.post("/youtube/pubsub", async (c) => {
  const body = await c.req.text();
  console.log("PubSubHubbub notification received");

  let entries = parseFeedEntries(body);
  if (!entries.length) {
    const videoId = extractXmlTag(body, "yt:videoId");
    const channelId = extractXmlTag(body, "yt:channelId");
    if (videoId && channelId) {
      entries = [{
        videoId,
        channelId,
        title: extractEntryXmlTag(body, "title") || extractXmlTag(body, "title") || "",
        channelName: extractEntryXmlTag(body, "name") || extractXmlTag(body, "name") || "",
        publishedAt: extractEntryXmlTag(body, "published") || extractXmlTag(body, "published") || new Date().toISOString(),
      }];
    }
  }

  if (!entries.length) {
    console.error("Could not parse video/channel ID from notification");
    return c.text("OK", 200);
  }

  for (const entry of entries) {
    const result = await ingestNotification(c.env, entry, "ingest");
    console.log(`Ingest ${entry.videoId}: ${result.action}${result.reason ? ` (${result.reason})` : ""}`);
  }

  return c.text("OK", 200);
});

// ────────────────────────────────────────
// 2. Inbox REST (KV)
// ────────────────────────────────────────

/** GET /api/categories */
app.get("/api/categories", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const raw = await c.env.YT_KV.get(KV_CATEGORIES);
  let categories = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(categories) || categories.length === 0) {
    categories = DEFAULT_CATEGORIES;
    await c.env.YT_KV.put(KV_CATEGORIES, JSON.stringify(categories));
    return c.json(categories);
  }
  const seeded = seedCategories(categories);
  if (seeded.changed) {
    await c.env.YT_KV.put(KV_CATEGORIES, JSON.stringify(seeded.list));
  }
  return c.json(seeded.list);
});

/** POST /api/categories */
app.post("/api/categories", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const { name, prompt, model, visualAssets } = await c.req.json();
  if (!name || !prompt) return c.json({ error: "Missing name or prompt" }, 400);

  // Only persist visual settings when the toggle is on — keeps old payloads from lingering
  const visual =
    visualAssets && visualAssets.enabled
      ? {
          enabled: true,
          kinds: Array.isArray(visualAssets.kinds) ? visualAssets.kinds.slice(0, 12) : [],
          model: visualAssets.model || "gemini-3.7-flash",
          mediaResolution: visualAssets.mediaResolution === "high" ? "high" : "default",
          materialize: visualAssets.materialize === "stills" ? "stills" : "index",
        }
      : undefined;

  const raw = await c.env.YT_KV.get(KV_CATEGORIES);
  let categories: any[] = raw ? JSON.parse(raw) : DEFAULT_CATEGORIES;

  const existingIndex = categories.findIndex((cat: any) => cat.name === name);
  if (existingIndex !== -1) {
    categories[existingIndex].prompt = prompt;
    if (model) categories[existingIndex].model = model;
    if (visual) categories[existingIndex].visualAssets = visual;
    else delete categories[existingIndex].visualAssets;
  } else {
    categories.push({ name, prompt, model: model || "gemini-3.1-flash-lite", ...(visual ? { visualAssets: visual } : {}) });
  }

  await c.env.YT_KV.put(KV_CATEGORIES, JSON.stringify(categories));
  return c.json({ ok: true, count: categories.length });
});

/** POST /api/categories/rename */
app.post("/api/categories/rename", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const { oldName, newName } = await c.req.json();
  if (!oldName || !newName) return c.json({ error: "Missing oldName or newName" }, 400);

  const raw = await c.env.YT_KV.get(KV_CATEGORIES);
  let categories: any[] = raw ? JSON.parse(raw) : DEFAULT_CATEGORIES;

  const existingIndex = categories.findIndex((cat: any) => cat.name === oldName);
  if (existingIndex !== -1) {
    categories[existingIndex].name = newName;
    await c.env.YT_KV.put(KV_CATEGORIES, JSON.stringify(categories));
    return c.json({ ok: true });
  }
  return c.json({ error: "Category not found" }, 404);
});

/** DELETE /api/categories */
app.delete("/api/categories", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "Missing name" }, 400);

  const raw = await c.env.YT_KV.get(KV_CATEGORIES);
  let categories: any[] = raw ? JSON.parse(raw) : DEFAULT_CATEGORIES;

  categories = categories.filter((cat: any) => cat.name !== name);

  await c.env.YT_KV.put(KV_CATEGORIES, JSON.stringify(categories));
  return c.json({ ok: true, count: categories.length });
});

/** GET /api/categorisation-prompt */
app.get("/api/categorisation-prompt", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const raw = await c.env.YT_KV.get(KV_CATEGORISATION_PROMPT);
  if (!raw) {
    return c.json({ prompt: "", model: "" });
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "prompt" in parsed) {
      return c.json({ prompt: parsed.prompt, model: parsed.model || "" });
    }
  } catch (e) {}
  return c.json({ prompt: raw, model: "" });
});

/** POST /api/categorisation-prompt */
app.post("/api/categorisation-prompt", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  if (typeof body.prompt !== "string") {
    return c.json({ error: "Invalid prompt" }, 400);
  }
  const payload = {
    prompt: body.prompt,
    model: body.model || ""
  };
  await c.env.YT_KV.put(KV_CATEGORISATION_PROMPT, JSON.stringify(payload));
  return c.json({ ok: true });
});

/** GET /api/channels */
app.get("/api/channels", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  let channels = await readChannels(c.env.YT_KV);
  const placeholders = channels.filter((ch) => isPlaceholderChannelName(ch.name));
  let namesChanged = false;
  if (placeholders.length && c.env.GOOGLE_API_KEY) {
    const titles = await fetchChannelTitles(placeholders.map((ch) => ch.id), c.env.GOOGLE_API_KEY);
    channels = channels.map((ch) => {
      const title = titles.get(ch.id);
      if (!title) return ch;
      namesChanged = true;
      return { ...ch, name: title };
    });
  }
  const raw = await c.env.YT_KV.get(KV_TRACKED_CHANNELS);
  let stored: Array<{ id?: string }> = [];
  try { stored = raw ? JSON.parse(raw) : []; } catch { stored = []; }
  const storedIds = (Array.isArray(stored) ? stored : []).map((ch) => ch.id).join("\n");
  const liveIds = channels.map((ch) => ch.id).join("\n");
  if (namesChanged || storedIds !== liveIds) {
    await writeChannels(c.env.YT_KV, channels);
  }
  return c.json(channels);
});

/** PUT /api/channels — Replace tracked list with the payload (normalized). */
app.put("/api/channels", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const channels = await c.req.json();
  if (!Array.isArray(channels)) return c.json({ error: "Invalid payload, expected array" }, 400);

  const next = await writeChannels(c.env.YT_KV, channels);
  return c.json({ ok: true, count: next.length });
});

/** POST /api/channels */
app.post("/api/channels", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const channel = await c.req.json();
  const next = await addChannel(c.env.YT_KV, channel);
  return c.json({ ok: true, count: next.length });
});

/** DELETE /api/channels */
app.delete("/api/channels", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const { channelId } = await c.req.json();
  if (!channelId) return c.json({ error: "Missing channelId" }, 400);

  const result = await removeChannel(c.env.YT_KV, channelId);
  const origin = new URL(c.req.url).origin;
  const callback = c.env.PUBSUB_CALLBACK_URL || `${origin}/youtube/pubsub`;
  c.executionCtx.waitUntil(unsubscribePubSub(channelId, callback));
  return c.json({ ok: true, removed: result.removed });
});

/** GET /api/videos/pending */
app.get("/api/videos/pending", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await readPending(c.env.YT_KV));
});

/** PUT /api/videos/pending — Upsert the given videos. Never resurrects discarded ids or drops unknown ids. */
app.put("/api/videos/pending", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const pending = await c.req.json();
  if (!Array.isArray(pending)) return c.json({ error: "Invalid payload, expected array" }, 400);

  const result = await serialize(() => upsertPendingList(c.env.YT_KV, pending));
  return c.json({ ok: true, count: result.count });
});

/** PATCH /api/videos/pending — Update fields on existing pending videos */
app.patch("/api/videos/pending", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const patches = Array.isArray(body) ? body : body.videos;
  if (!Array.isArray(patches)) return c.json({ error: "Invalid payload, expected videos array" }, 400);

  const result = await serialize(() => patchPending(c.env.YT_KV, patches));
  return c.json({ ok: true, count: result.count });
});

/** POST /api/videos/pending — Add a video */
app.post("/api/videos/pending", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

  const video = await c.req.json();
  const restore = video?.source !== "ingest";
  if (video?.videoId && !video.duration && c.env.GOOGLE_API_KEY) {
    const meta = await fetchVideoMeta(video.videoId, c.env.GOOGLE_API_KEY);
    if (!restore && meta.seconds != null && meta.seconds < MIN_PENDING_SECONDS) {
      const raw = await c.env.YT_KV.get(KV_CATEGORIES);
      let cats: any[] = [];
      try { cats = raw ? JSON.parse(raw) : []; } catch { cats = []; }
      if (!categoryAllowsShorts(video.category, cats)) {
        return c.json({ ok: true, skipped: "short", count: 0 });
      }
    }
    if (meta.duration) video.duration = meta.duration;
    if (meta.title && (!video.title || video.title === "YouTube video feed")) video.title = meta.title;
  }
  const result = await serialize(() => addPending(c.env.YT_KV, video, { restore }));
  return c.json({ ok: true, skipped: result.skipped, count: result.count });
});

/** DELETE /api/videos/pending — Remove videos by IDs */
/** DELETE /api/videos/pending — discard unprocessed pending videos.
 *  Ids that already have a saved note are skipped: completion is not discard (issue #5). */
app.delete("/api/videos/pending", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

  const { videoIds } = await c.req.json();
  const result = await serialize(() => discardPending(c.env.YT_KV, Array.isArray(videoIds) ? videoIds : []));
  return c.json({ ok: true, removed: result.removed, skipped: result.skipped });
});

/** GET /api/videos/processed/:videoId */
app.get("/api/videos/processed/:videoId", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

  const videoId = c.req.param("videoId");
  const existing = await c.env.YT_KV.get(`${KV_PROCESSED_PREFIX}${videoId}`);
  return c.json({ exists: !!existing });
});

/** POST /api/videos/processed — Save a processed video and complete its inbox item.
 *  Completion is the Worker's job (issue #5): the pending row is removed here,
 *  not by the writers.
 *
 *  Patch semantics: a re-save patches the stored note instead of replacing it.
 *  - Metadata (description*, geminiChatUrl, cues, sourceVideoIds, branchSource,
 *    analysisSource): kept from the previous note when the payload omits them.
 *  - Content (analysis, analysisTurns, transcript, assets, visualStatus,
 *    visualNote, cost, usage): replaced only when the writer sends them; send
 *    null / [] to clear, omit to preserve. */
const NOTE_MERGE_FIELDS = [
  "description", "descriptionBlock", "descriptionStatus", "geminiChatUrl",
  "cues", "sourceVideoIds", "branchSource", "analysisSource",
  "analysis", "analysisTurns", "transcript", "assets",
  "visualStatus", "visualNote", "cost", "usage",
];

app.post("/api/videos/processed", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

  const video = await c.req.json();
  const dateKey = video.processedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const prevRaw = await c.env.YT_KV.get(analysisKey(dateKey, video.videoId));
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw);
      for (const field of NOTE_MERGE_FIELDS) {
        if (video[field] === undefined && prev?.[field] != null) video[field] = prev[field];
      }
    } catch { /* keep incoming */ }
  }
  const result = await completeInboxNote(c.env.YT_KV, video);

  return c.json({ ok: true, removedFromPending: result.removedFromPending });
});

/** DELETE /api/videos/processed/:videoId — undo a completed note */
app.delete("/api/videos/processed/:videoId", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const videoId = c.req.param("videoId");
  if (!videoId) return c.json({ error: "Missing videoId" }, 400);

  await serialize(async () => {
    await c.env.YT_KV.delete(`${KV_PROCESSED_PREFIX}${videoId}`);
    const date = (c.req.query("date") || c.req.query("processedAt") || "").slice(0, 10);
    const gone = await removeFromAnalysisIndex(c.env.YT_KV, videoId);
    const keys = new Set(gone.map((row) => analysisKey(row.date, videoId)));
    if (date) keys.add(analysisKey(date, videoId));
    await Promise.all([...keys].map((name) => c.env.YT_KV.delete(name)));
  });

  return c.json({ ok: true });
});

/** GET /api/videos/analyses?date=YYYY-MM-DD or date=all */
app.get("/api/videos/analyses", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  return c.json(await readAnalyses(c.env.YT_KV, date));
});

/** GET /api/videos/failed */
app.get("/api/videos/failed", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const raw = await c.env.YT_KV.get(KV_FAILED);
  return c.json(raw ? JSON.parse(raw) : []);
});

/** POST /api/videos/failed — append a failed process record */
app.post("/api/videos/failed", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const entry = await c.req.json();
  const raw = await c.env.YT_KV.get(KV_FAILED);
  const list: any[] = raw ? JSON.parse(raw) : [];
  const next = [entry, ...list.filter((v) => v.videoId !== entry.videoId)].slice(0, 100);
  await c.env.YT_KV.put(KV_FAILED, JSON.stringify(next));
  return c.json({ ok: true, count: next.length });
});

/** DELETE /api/videos/failed */
app.delete("/api/videos/failed", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const { videoId } = await c.req.json();
  const raw = await c.env.YT_KV.get(KV_FAILED);
  const list: any[] = raw ? JSON.parse(raw) : [];
  const next = videoId ? list.filter((v) => v.videoId !== videoId) : [];
  await c.env.YT_KV.put(KV_FAILED, JSON.stringify(next));
  return c.json({ ok: true });
});

/** GET /api/costs/daily?date=YYYY-MM-DD */
app.get("/api/costs/daily", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  const raw = await c.env.YT_KV.get(`${KV_DAILY_COST_PREFIX}${date}`);
  return c.json(raw ? JSON.parse(raw) : { date, cost: 0, tokens: 0 });
});

/** POST /api/costs/daily */
app.post("/api/costs/daily", async (c) => {
  if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const date = body.date || new Date().toISOString().slice(0, 10);
  
  const raw = await c.env.YT_KV.get(`${KV_DAILY_COST_PREFIX}${date}`);
  const current = raw ? JSON.parse(raw) : { date, cost: 0, tokens: 0 };
  
  current.cost += (body.cost || 0);
  current.tokens += (body.tokens || 0);
  
  await c.env.YT_KV.put(`${KV_DAILY_COST_PREFIX}${date}`, JSON.stringify(current));
  return c.json(current);
});

// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

const PUBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

async function unsubscribePubSub(channelId: string, callbackUrl: string): Promise<void> {
  const topic = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const response = await fetch(PUBSUB_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "unsubscribe",
        "hub.topic": topic,
        "hub.callback": callbackUrl,
        "hub.verify": "async",
      }).toString(),
    });
    if (response.status !== 202 && response.status !== 204) {
      console.warn(`Unsubscribe ${channelId} status ${response.status}: ${await response.text()}`);
    }
  } catch (err) {
    console.warn(`Unsubscribe failed for ${channelId}:`, err);
  }
}

async function fetchChannelTitles(ids: string[], apiKey: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const group = ids.slice(i, i + 50);
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${group.map(encodeURIComponent).join(",")}&key=${apiKey}`
      );
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const item of data.items || []) {
        const name = decodeHtmlEntities(String(item.snippet?.title || "")).replace(/\s+-\s+YouTube$/i, "").trim();
        if (item.id && name && !isPlaceholderChannelName(name)) titles.set(item.id, name);
      }
    } catch {
      /* keep KV names */
    }
  }
  return titles;
}

// ── Health check ──

app.get("/", (c) => c.json({ status: "ok", service: "yt-pipeline-worker" }));

export { app };

export default {
  fetch: app.fetch,
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduledIngest(env));
  },
};
