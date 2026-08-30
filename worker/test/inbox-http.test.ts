import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/index";
import { KV_PENDING } from "../src/store";

const SECRET = "test-secret";

function mockKv(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list(opts: { prefix: string; cursor?: string }) {
      const keys = [...map.keys()].filter((name) => name.startsWith(opts.prefix)).map((name) => ({ name }));
      return { keys, list_complete: true as const };
    },
  };
}

function env(kv = mockKv()) {
  return {
    YT_KV: kv as unknown as KVNamespace,
    WORKER_API_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
  };
}

function auth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRET}`,
      ...(init.headers || {}),
    },
  };
}

test("GET /api/videos/pending without auth is 401", async () => {
  const res = await app.request("/api/videos/pending", {}, env());
  assert.equal(res.status, 401);
});

test("GET /api/videos/pending returns a JSON array", async () => {
  const kv = mockKv({
    [KV_PENDING]: JSON.stringify([{ videoId: "vid-a", title: "A" }]),
  });
  const res = await app.request("/api/videos/pending", auth(), env(kv));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.equal(body[0].videoId, "vid-a");
});

test("POST /api/videos/pending accepts one video object", async () => {
  const kv = mockKv({ [KV_PENDING]: "[]" });
  const res = await app.request(
    "/api/videos/pending",
    auth({
      method: "POST",
      body: JSON.stringify({
        videoId: "vid-b",
        title: "B",
        channelId: "UC1",
        channelName: "Chan",
        category: "growth",
        publishedAt: "2026-01-01T00:00:00.000Z",
        videoUrl: "https://www.youtube.com/watch?v=vid-b",
        addedAt: "2026-01-01T00:00:00.000Z",
      }),
    }),
    env(kv)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-b"), true);
});

test("PATCH /api/videos/pending takes { videos } and updates fields", async () => {
  const kv = mockKv({
    [KV_PENDING]: JSON.stringify([{ videoId: "vid-c", title: "C", category: "growth" }]),
  });
  const res = await app.request(
    "/api/videos/pending",
    auth({
      method: "PATCH",
      body: JSON.stringify({ videos: [{ videoId: "vid-c", category: "ai concepts" }] }),
    }),
    env(kv)
  );
  assert.equal(res.status, 200);
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue[0].category, "ai concepts");
});

test("DELETE /api/videos/pending takes { videoIds } and removes them", async () => {
  const kv = mockKv({
    [KV_PENDING]: JSON.stringify([{ videoId: "vid-d", title: "D" }]),
  });
  const res = await app.request(
    "/api/videos/pending",
    auth({
      method: "DELETE",
      body: JSON.stringify({ videoIds: ["vid-d"] }),
    }),
    env(kv)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-d"), false);
});

test("DELETE /api/videos/pending refuses ids that already have a note", async () => {
  const kv = mockKv(pendingSeed(["vid-f"]));
  await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-e") }),
    env(kv)
  );
  // vid-e has a note but is not pending; discarding it must be a no-op that
  // does not add a processed video to the discarded list.
  const res = await app.request(
    "/api/videos/pending",
    auth({
      method: "DELETE",
      body: JSON.stringify({ videoIds: ["vid-e", "vid-f"] }),
    }),
    env(kv)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, 1);
  assert.deepEqual(body.skipped, ["vid-e"]);
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-e"), false);
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-f"), false);
  // Completion then undo: the note delete does not resurrect the pending row…
  await app.request(
    "/api/videos/processed/vid-e?date=2026-02-01",
    auth({ method: "DELETE" }),
    env(kv)
  );
  const after = await app.request("/api/videos/pending", auth(), env(kv));
  assert.equal((await after.json()).some((v: { videoId: string }) => v.videoId === "vid-e"), false);
  // …and re-ingesting the same video is NOT blocked by a stale discarded entry.
  const reingest = await app.request(
    "/api/videos/pending",
    auth({
      method: "POST",
      body: JSON.stringify({ videoId: "vid-e", title: "E", source: "ingest" }),
    }),
    env(kv)
  );
  assert.equal(reingest.status, 200);
  const reborn = await app.request("/api/videos/pending", auth(), env(kv));
  assert.equal((await reborn.json()).some((v: { videoId: string }) => v.videoId === "vid-e"), true);
});

test("POST /api/videos/processed re-save patches fields instead of dropping them", async () => {
  const kv = mockKv();
  await app.request(
    "/api/videos/processed",
    auth({
      method: "POST",
      body: noteBody("vid-i", {
        analysisSource: "gemini-web",
        analysisTurns: [{ role: "model", markdown: "hi" }],
        transcript: "spoken words",
        descriptionStatus: "added",
        descriptionBlock: "## From the description",
        geminiChatUrl: "https://gemini.google.com/app/x",
        assets: [{ t: "01:00", type: "chart", title: "T", reconstruction: "|a|" }],
      }),
    }),
    env(kv)
  );
  // Re-save with only analysis: metadata and visual fields survive.
  await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-i") }),
    env(kv)
  );
  const history = await app.request("/api/videos/analyses?date=2026-02-01", auth(), env(kv));
  const notes = await history.json();
  const note = notes.find((n: { videoId: string }) => n.videoId === "vid-i");
  assert.equal(note.analysisSource, "gemini-web");
  assert.equal(note.analysis, "## Note for vid-i");
  assert.equal(note.analysisTurns.length, 1);
  assert.equal(note.transcript, "spoken words");
  assert.equal(note.descriptionStatus, "added");
  assert.equal(note.geminiChatUrl, "https://gemini.google.com/app/x");
  assert.equal(note.assets.length, 1);
  // Explicit null clears a field the writer no longer wants.
  await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-i", { assets: null, visualStatus: null, visualNote: null }) }),
    env(kv)
  );
  const after = await app.request("/api/videos/analyses?date=2026-02-01", auth(), env(kv));
  const cleared = (await after.json()).find((n: { videoId: string }) => n.videoId === "vid-i");
  assert.equal(cleared.assets, null);
  assert.equal(cleared.visualStatus, null);
});

// ── Completion envelope: saving a note completes the inbox item ──
// Shared completion (issue #5): POST /api/videos/processed removes the video
// from pending itself — writers no longer do their own cleanup. Undoing the
// note does NOT bring it back; restore is an explicit client decision.

function pendingSeed(ids: string[]): Record<string, string> {
  return {
    [KV_PENDING]: JSON.stringify(ids.map((videoId) => ({
      videoId,
      title: videoId.toUpperCase(),
      channelId: "UC1",
      channelName: "Chan",
      category: "growth",
      publishedAt: "2026-01-01T00:00:00.000Z",
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      addedAt: "2026-01-01T00:00:00.000Z",
    }))),
  };
}

function noteBody(videoId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    videoId,
    title: videoId.toUpperCase(),
    analysis: `## Note for ${videoId}`,
    processedAt: "2026-02-01T10:00:00.000Z",
    ...extra,
  });
}

test("POST /api/videos/processed completes a pending video", async () => {
  const kv = mockKv(pendingSeed(["vid-e", "vid-f"]));
  const res = await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-e") }),
    env(kv)
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removedFromPending: 1 });
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-e"), false);
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-f"), true);
  const history = await app.request("/api/videos/analyses?date=2026-02-01", auth(), env(kv));
  const notes = await history.json();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].videoId, "vid-e");
});

test("POST /api/videos/processed without a pending row still saves the note", async () => {
  const kv = mockKv();
  const res = await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-g") }),
    env(kv)
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removedFromPending: 0 });
  const history = await app.request("/api/videos/analyses?date=2026-02-01", auth(), env(kv));
  const notes = await history.json();
  assert.equal(notes.length, 1);
});

test("DELETE /api/videos/processed undoes the note but does not restore pending", async () => {
  const kv = mockKv(pendingSeed(["vid-h"]));
  await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-h") }),
    env(kv)
  );
  const del = await app.request(
    "/api/videos/processed/vid-h?date=2026-02-01",
    auth({ method: "DELETE" }),
    env(kv)
  );
  assert.equal(del.status, 200);
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-h"), false);
  const history = await app.request("/api/videos/analyses?date=2026-02-01", auth(), env(kv));
  const notes = await history.json();
  assert.equal(notes.length, 0);
});
