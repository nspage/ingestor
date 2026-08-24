import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPatches,
  canonicalChannelId,
  displayChannelName,
  findTrackedChannel,
  isPlaceholderChannelName,
  mergePending,
  normalizeChannels,
  removePendingIds,
  removeTrackedIds,
  shouldIngestChannel,
  upsertPending,
} from "../src/queue";

test("mergePending drops discarded ids even if a stale list still has them", () => {
  const stale = [
    { videoId: "old-a", title: "A" },
    { videoId: "old-b", title: "B" },
  ];
  const keys = [{ videoId: "new-pick", title: "Picked" }];
  const merged = mergePending(stale, keys, ["old-a", "old-b"]);
  assert.deepEqual(merged.map((v) => v.videoId), ["new-pick"]);
});

test("mergePending prefers per-video keys over a stale list for the same id", () => {
  const list = [{ videoId: "v1", title: "stale", category: "old" }];
  const keys = [{ videoId: "v1", title: "fresh", category: "ai concepts" }];
  const merged = mergePending(list, keys, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "fresh");
  assert.equal(merged[0].category, "ai concepts");
});

test("stale full-list overwrite cannot resurrect discarded videos after merge", () => {
  const discarded = ["a", "b", "c"];
  const stalePut = [
    { videoId: "a", title: "A" },
    { videoId: "b", title: "B" },
    { videoId: "c", title: "C" },
    { videoId: "kept", title: "Kept" },
  ];
  const liveKeys = [{ videoId: "picked", title: "Picked" }];
  const merged = mergePending(stalePut, liveKeys, discarded);
  assert.deepEqual(merged.map((v) => v.videoId).sort(), ["kept", "picked"]);
});

test("removePendingIds removes a whole batch in one pass", () => {
  const list = ["a", "b", "c", "d"].map((videoId) => ({ videoId }));
  const next = removePendingIds(list, ["a", "b", "c"]);
  assert.deepEqual(next.map((v) => v.videoId), ["d"]);
});

test("upsertPending adds a picked video without dropping existing ones", () => {
  const list = [{ videoId: "kept" }];
  const next = upsertPending(list, { videoId: "picked", title: "Picked" });
  assert.deepEqual(next.map((v) => v.videoId).sort(), ["kept", "picked"]);
});

test("applyPatches updates category without replacing the queue", () => {
  const list = [
    { videoId: "a", category: "old" },
    { videoId: "b", category: "keep" },
  ];
  const next = applyPatches(list, [{ videoId: "a", category: "ai concepts" }]);
  assert.equal(next[0].category, "ai concepts");
  assert.equal(next[1].category, "keep");
  assert.equal(next.length, 2);
});

test("shouldIngestChannel uses only the KV tracked list", () => {
  const tracked = [{ id: "UC-real" }];
  assert.equal(shouldIngestChannel("UC-real", tracked), true);
  assert.equal(shouldIngestChannel("UC-other", tracked), false);
  assert.equal(shouldIngestChannel("UC-real", tracked, ["UC-real"]), false);
  assert.equal(shouldIngestChannel("UC-real", []), false);
  assert.equal(shouldIngestChannel("UC0C_17n9iuUQPylguM1d_lQ", [{ id: "UC0C-17n9iuUQPylguM1d-lQ" }]), false);
});

test("a channel not in any old hardcoded list tracks when it is in KV", () => {
  const tracked = [{ id: "UCbrand-new-channel", name: "New", category: "growth" }];
  assert.equal(shouldIngestChannel("UCbrand-new-channel", tracked), true);
  assert.equal(findTrackedChannel("UCbrand-new-channel", tracked)?.category, "growth");
});

test("placeholder channel names include Visit source and Channel-N", () => {
  assert.equal(isPlaceholderChannelName("Visit source"), true);
  assert.equal(isPlaceholderChannelName("Channel-05"), true);
  assert.equal(isPlaceholderChannelName("YouTube video feed"), true);
  assert.equal(isPlaceholderChannelName("Nate Herk | AI Automation"), false);
});

test("displayChannelName uses the KV name only, never a hardcoded title map", () => {
  assert.equal(
    displayChannelName({ id: "UC0C_17n9iuUQPylguM1d_lQ", name: "Visit source" }),
    "UC0C_17n9iuUQPylguM1d_lQ"
  );
  assert.equal(
    displayChannelName({ id: "UCkeep", name: "AI News &amp; Strategy Daily | Nate B Jones" }),
    "AI News & Strategy Daily | Nate B Jones"
  );
});

test("normalizeChannels decodes HTML names and does not merge unrelated ids", () => {
  const next = normalizeChannels([
    { id: "UC0C_17n9iuUQPylguM1d_lQ", name: "Visit source", category: "ai concepts" },
    { id: "UC0C-17n9iuUQPylguM1d-lQ", name: "AI News &amp; Strategy Daily | Nate B Jones", category: "ai concepts" },
  ]);
  assert.equal(next.length, 2);
  assert.equal(next.find((c) => c.id.startsWith("UC0C-"))?.name, "AI News & Strategy Daily | Nate B Jones");
});

test("removeTrackedIds removes only the exact KV id", () => {
  const channels = [
    { id: "UC0C-17n9iuUQPylguM1d-lQ", name: "Nate", category: "ai concepts" },
    { id: "UCkeep", name: "Keep", category: "growth" },
  ];
  const next = removeTrackedIds(channels, "UC0C-17n9iuUQPylguM1d-lQ");
  assert.deepEqual(next.map((c) => c.id), ["UCkeep"]);
  assert.equal(removeTrackedIds(channels, "UC0C_17n9iuUQPylguM1d_lQ").length, 2);
});

test("canonicalChannelId does not rewrite ids from a hardcoded alias map", () => {
  assert.equal(canonicalChannelId("UC2ojq_nuP8ceeHqiroeKhBA"), "UC2ojq_nuP8ceeHqiroeKhBA");
  assert.equal(canonicalChannelId("  UCkeep  "), "UCkeep");
});
