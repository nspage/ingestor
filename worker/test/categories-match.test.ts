import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CATEGORY_NAMES,
  CATEGORY_VOCABULARY,
  canonicalCategory,
} from "../src/queue";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const categoriesJs = readFileSync(join(root, "chrome-extension/app/categories.js"), "utf8");

function evalCategoriesJs() {
  const src = categoriesJs.replace(/^export /gm, "");
  const fn = new Function(
    `${src}; return { CATEGORY_VOCABULARY, CATEGORY_NAMES, DEFAULT_CATEGORISATION_PROMPT, normalizeCategory };`
  );
  return fn() as {
    CATEGORY_VOCABULARY: Array<{ name: string; description: string }>;
    CATEGORY_NAMES: string[];
    DEFAULT_CATEGORISATION_PROMPT: string;
    normalizeCategory: (value: unknown) => string;
  };
}

test("extension categories.js vocabulary matches worker queue.ts", () => {
  const ext = evalCategoriesJs();
  assert.deepEqual([...ext.CATEGORY_NAMES], [...CATEGORY_NAMES]);
  assert.deepEqual(
    ext.CATEGORY_VOCABULARY.map((c) => ({ name: c.name, description: c.description })),
    CATEGORY_VOCABULARY.map((c) => ({ name: c.name, description: c.description }))
  );
});

test("extension categories.js normalizes like the worker", () => {
  const ext = evalCategoriesJs();
  assert.equal(ext.normalizeCategory("**Strategy**"), canonicalCategory("**Strategy**"));
  assert.equal(ext.normalizeCategory("second brain"), canonicalCategory("second brain"));
  assert.equal(ext.normalizeCategory("growth"), canonicalCategory("growth"));
  assert.equal(ext.normalizeCategory(""), canonicalCategory(""));
});

test("content.js copies the same vocabulary for its fallbacks", () => {
  const src = readFileSync(join(root, "chrome-extension/content.js"), "utf8");
  const list = src.match(/const CATEGORY_NAMES = (\[[\s\S]*?\]);/);
  assert.ok(list, "content.js must declare CATEGORY_NAMES");
  assert.deepEqual(Function(`return ${list[1]}`)(), [...CATEGORY_NAMES]);
  const fallback = src.match(/const DEFAULT_CATEGORY = "([^"]+)"/);
  assert.ok(fallback, "content.js must declare DEFAULT_CATEGORY");
  assert.equal(canonicalCategory(fallback![1]), fallback![1], "DEFAULT_CATEGORY must be in the vocabulary");
});
