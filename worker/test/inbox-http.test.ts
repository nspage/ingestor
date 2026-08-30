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

// ── Completion envelope: saving a note vs the pending queue ──
// Characterization of today's semantics (issue #5): POST /api/videos/processed
// only stores the note — removing the video from pending is left to each writer
// (helper process-video.ts, extension importGeminiNote). These tests pin the
// envelope so the shared-completion change cannot silently alter it.

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

test("POST /api/videos/processed stores the note and leaves pending untouched (writer's job today)", async () => {
  const kv = mockKv(pendingSeed(["vid-e", "vid-f"]));
  const res = await app.request(
    "/api/videos/processed",
    auth({ method: "POST", body: noteBody("vid-e") }),
    env(kv)
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const listed = await app.request("/api/videos/pending", auth(), env(kv));
  const queue = await listed.json();
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-e"), true);
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
  assert.deepEqual(await res.json(), { ok: true });
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
  assert.equal(queue.some((v: { videoId: string }) => v.videoId === "vid-h"), true);
  const history = await app.request("/api/videos/analyses?date=2026-02-01", auth(), env(kv));
  const notes = await history.json();
  assert.equal(notes.length, 0);
});
