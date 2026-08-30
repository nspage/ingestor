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
