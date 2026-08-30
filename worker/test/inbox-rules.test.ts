import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MIN_PENDING_SECONDS,
  PLACEHOLDER_CHANNEL_NAMES,
} from "../src/queue";
import {
  MIN_PENDING_SECONDS as EXT_MIN,
  PLACEHOLDER_CHANNEL_NAMES as EXT_NAMES,
} from "../../chrome-extension/app/inbox-rules.js";

test("extension inbox-rules.js matches worker queue.ts", () => {
  assert.equal(EXT_MIN, MIN_PENDING_SECONDS);
  assert.deepEqual([...EXT_NAMES], [...PLACEHOLDER_CHANNEL_NAMES]);
});

test("content.js copies the same shorts cutoff and placeholder list", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const src = readFileSync(join(root, "chrome-extension/content.js"), "utf8");
  const min = src.match(/const MIN_PENDING_SECONDS = (\d+)/);
  assert.equal(Number(min?.[1]), MIN_PENDING_SECONDS);
  const list = src.match(/const PLACEHOLDER_CHANNEL_NAMES = (\[[\s\S]*?\]);/);
  assert.ok(list, "content.js must declare PLACEHOLDER_CHANNEL_NAMES");
  assert.deepEqual(Function(`return ${list[1]}`)(), PLACEHOLDER_CHANNEL_NAMES);
});
