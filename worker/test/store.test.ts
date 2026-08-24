import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addPending,
  analysisKey,
  discardPending,
  readAnalyses,
  readAnalysisIndex,
  readPending,
  upsertAnalysisIndex,
  KV_DISCARDED,
  KV_PENDING,
  KV_PENDING_PREFIX,
  KV_STORE_BLOB,
} from "../src/store";

function mockKv(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const lists: string[] = [];
  return {
    lists,
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
      lists.push(opts.prefix);
      const keys = [...map.keys()].filter((name) => name.startsWith(opts.prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    has(key: string) {
      return map.has(key);
    },
    getRaw(key: string) {
      return map.get(key);
    },
  };
}

test("hydrate merges prefix keys into blobs then pending reads do not list", async () => {
  const kv = mockKv({
    [KV_PENDING]: JSON.stringify([{ videoId: "blob-a", title: "A" }]),
    [`${KV_PENDING_PREFIX}key-b`]: JSON.stringify({ videoId: "key-b", title: "B" }),
  });
  const first = await readPending(kv);
  assert.deepEqual(first.map((v) => v.videoId).sort(), ["blob-a", "key-b"]);
  assert.equal(kv.has(KV_STORE_BLOB), true);
  assert.equal(kv.has(`${KV_PENDING_PREFIX}key-b`), false);
  kv.lists.length = 0;
  const second = await readPending(kv);
  assert.deepEqual(second.map((v) => v.videoId).sort(), ["blob-a", "key-b"]);
  assert.equal(kv.lists.length, 0);
});

test("addPending and discardPending only touch blobs", async () => {
  const kv = mockKv({ [KV_STORE_BLOB]: "1", [KV_PENDING]: "[]", [KV_DISCARDED]: "[]" });
  await addPending(kv, { videoId: "v1", title: "One" });
  assert.equal(kv.has(`${KV_PENDING_PREFIX}v1`), false);
  const pending = JSON.parse(kv.getRaw(KV_PENDING) || "[]");
  assert.equal(pending[0].videoId, "v1");
  await discardPending(kv, ["v1"]);
  assert.deepEqual(JSON.parse(kv.getRaw(KV_PENDING) || "[]"), []);
  assert.deepEqual(JSON.parse(kv.getRaw(KV_DISCARDED) || "[]"), ["v1"]);
});

test("analysis index upsert then readAnalyses does not list", async () => {
  const kv = mockKv();
  const note = { videoId: "abc", title: "Note", processedAt: "2026-08-23T12:00:00.000Z" };
  await kv.put(analysisKey("2026-08-23", "abc"), JSON.stringify(note));
  await upsertAnalysisIndex(kv, { videoId: "abc", date: "2026-08-23", processedAt: note.processedAt });
  kv.lists.length = 0;
  const rows = await readAnalyses(kv, "all");
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { title: string }).title, "Note");
  assert.equal(kv.lists.length, 0);
  const index = await readAnalysisIndex(kv);
  assert.equal(index[0].videoId, "abc");
});
