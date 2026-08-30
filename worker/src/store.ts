import {
  applyPatches,
  canonicalChannelId,
  mergePending,
  normalizeChannels,
  removePendingIds,
  removeTrackedIds,
  shouldIngestChannel,
  upsertPending,
  type PendingVideo,
  type TrackedChannel,
} from "./queue";

export const KV_PENDING = "pending_videos";
export const KV_PENDING_PREFIX = "pending:";
export const KV_DISCARDED = "discarded_videos";
export const KV_DISCARDED_PREFIX = "discarded:";
export const KV_TRACKED_CHANNELS = "tracked_channels";
export const KV_UNTRACKED = "untracked_channels";
export const KV_STORE_BLOB = "store_blob_v2";
export const KV_ANALYSIS_PREFIX = "analysis:";
export const KV_ANALYSIS_INDEX = "analysis_index";
/** Processed markers: `processed:<videoId>` = "1" once a note exists. */
export const KV_PROCESSED_PREFIX = "processed:";

let mutationChain: Promise<unknown> = Promise.resolve();

export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

function parseList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function listNames(kv: Kv, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) names.push(key.name);
    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return names;
}

async function readJsonKeys<T>(kv: Kv, names: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < names.length; i += 20) {
    const batch = names.slice(i, i + 20);
    const rows = await Promise.all(batch.map((name) => kv.get(name)));
    for (const raw of rows) {
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as T);
      } catch {
        /* skip corrupt */
      }
    }
  }
  return out;
}

const hydrateInflight = new WeakMap<Kv, Promise<void>>();

async function hydrateStore(kv: Kv): Promise<void> {
  const existing = hydrateInflight.get(kv);
  if (existing) return existing;
  const run = (async () => {
    if (await kv.get(KV_STORE_BLOB)) return;
    const [pendingNames, discardedNames] = await Promise.all([
      listNames(kv, KV_PENDING_PREFIX),
      listNames(kv, KV_DISCARDED_PREFIX),
    ]);
    const fromKeys = await readJsonKeys<PendingVideo>(kv, pendingNames);
    const fromList = parseList<PendingVideo>(await kv.get(KV_PENDING));
    const discarded = new Set<string>(parseList<string>(await kv.get(KV_DISCARDED)));
    for (const name of discardedNames) discarded.add(name.slice(KV_DISCARDED_PREFIX.length));
    discarded.delete("");
    const merged = mergePending(fromList, fromKeys, discarded);
    await writePendingList(kv, merged);
    await writeDiscardedList(kv, discarded);
    await Promise.all([
      ...pendingNames.map((name) => kv.delete(name)),
      ...discardedNames.map((name) => kv.delete(name)),
    ]);
    await kv.put(KV_STORE_BLOB, "1");
  })();
  hydrateInflight.set(kv, run);
  try {
    await run;
  } catch (err) {
    hydrateInflight.delete(kv);
    throw err;
  }
}

export async function readDiscardedIds(kv: Kv): Promise<Set<string>> {
  await hydrateStore(kv);
  const ids = new Set<string>(parseList<string>(await kv.get(KV_DISCARDED)));
  ids.delete("");
  return ids;
}

export async function readPending(kv: Kv): Promise<PendingVideo[]> {
  await hydrateStore(kv);
  const discarded = new Set(parseList<string>(await kv.get(KV_DISCARDED)));
  discarded.delete("");
  return mergePending(parseList<PendingVideo>(await kv.get(KV_PENDING)), [], discarded);
}

async function writePendingList(kv: Kv, list: PendingVideo[]): Promise<void> {
  await kv.put(KV_PENDING, JSON.stringify(list));
}

async function writeDiscardedList(kv: Kv, ids: Set<string>): Promise<void> {
  await kv.put(KV_DISCARDED, JSON.stringify([...ids]));
}

export async function addPending(
  kv: Kv,
  video: PendingVideo,
  opts: { restore?: boolean } = {}
): Promise<{ added: boolean; skipped?: string; count: number }> {
  if (!video?.videoId) return { added: false, skipped: "missing_id", count: 0 };
  const discarded = await readDiscardedIds(kv);
  if (discarded.has(video.videoId) && !opts.restore) {
    const list = await readPending(kv);
    return { added: false, skipped: "discarded", count: list.length };
  }
  if (opts.restore && discarded.has(video.videoId)) {
    discarded.delete(video.videoId);
    await writeDiscardedList(kv, discarded);
  }
  const list = upsertPending(await readPending(kv), video);
  await writePendingList(kv, list);
  return { added: true, count: list.length };
}

export async function discardPending(
  kv: Kv,
  videoIds: string[]
): Promise<{ removed: number; skipped: string[]; count: number }> {
  const ids = [...new Set((videoIds || []).filter(Boolean))];
  if (!ids.length) {
    const list = await readPending(kv);
    return { removed: 0, skipped: [], count: list.length };
  }
  // A video with a saved note is completed, not queued: discard must not eat it (issue #5).
  const processed = await Promise.all(ids.map(async (id) => [id, !!(await kv.get(KV_PROCESSED_PREFIX + id))] as const));
  const skipped = processed.filter(([, done]) => done).map(([id]) => id);
  const droppable = ids.filter((id) => !skipped.includes(id));
  const discarded = await readDiscardedIds(kv);
  for (const id of droppable) discarded.add(id);
  await writeDiscardedList(kv, discarded);
  const list = removePendingIds(await readPending(kv), droppable);
  await writePendingList(kv, list);
  return { removed: droppable.length, skipped, count: list.length };
}

export async function patchPending(
  kv: Kv,
  patches: PendingVideo[]
): Promise<{ count: number }> {
  const discarded = await readDiscardedIds(kv);
  const live = patches.filter((p) => p?.videoId && !discarded.has(p.videoId));
  const list = applyPatches(await readPending(kv), live);
  await writePendingList(kv, list);
  return { count: list.length };
}

export async function upsertPendingList(
  kv: Kv,
  incoming: PendingVideo[]
): Promise<{ count: number }> {
  const discarded = await readDiscardedIds(kv);
  let list = await readPending(kv);
  for (const video of incoming || []) {
    if (!video?.videoId || discarded.has(video.videoId)) continue;
    list = upsertPending(list, video);
  }
  await writePendingList(kv, list);
  return { count: list.length };
}

export async function readChannels(kv: Kv): Promise<TrackedChannel[]> {
  const raw = await kv.get(KV_TRACKED_CHANNELS);
  const untracked = await readUntrackedIds(kv);
  return normalizeChannels(parseList<TrackedChannel>(raw)).filter((ch) => {
    const id = canonicalChannelId(ch.id);
    return !untracked.has(id) && !untracked.has(ch.id);
  });
}

export async function readUntrackedIds(kv: Kv): Promise<Set<string>> {
  const raw = await kv.get(KV_UNTRACKED);
  return new Set(parseList<string>(raw).map(canonicalChannelId).filter(Boolean));
}

export async function writeChannels(kv: Kv, channels: TrackedChannel[]): Promise<TrackedChannel[]> {
  const untracked = await readUntrackedIds(kv);
  const normalized = normalizeChannels(channels).filter((ch) => {
    const id = canonicalChannelId(ch.id);
    return !untracked.has(id) && !untracked.has(ch.id);
  });
  await kv.put(KV_TRACKED_CHANNELS, JSON.stringify(normalized));
  return normalized;
}

export async function addChannel(kv: Kv, channel: TrackedChannel): Promise<TrackedChannel[]> {
  const channels = await readChannels(kv);
  const untracked = await readUntrackedIds(kv);
  const id = canonicalChannelId(channel.id);
  untracked.delete(id);
  await kv.put(KV_UNTRACKED, JSON.stringify([...untracked]));
  const next = normalizeChannels([...channels, { ...channel, id }]);
  return writeChannels(kv, next);
}

export async function removeChannel(kv: Kv, channelId: string): Promise<{ removed: number; channels: TrackedChannel[] }> {
  const id = canonicalChannelId(channelId);
  const channels = await readChannels(kv);
  const next = removeTrackedIds(channels, channelId);
  const untracked = await readUntrackedIds(kv);
  if (id) untracked.add(id);
  if (channelId) untracked.add(channelId);
  await kv.put(KV_UNTRACKED, JSON.stringify([...untracked]));
  await writeChannels(kv, next);
  return { removed: channels.length - next.length, channels: next };
}

export async function isTrackedChannel(kv: Kv, channelId: string): Promise<boolean> {
  const [channels, untracked] = await Promise.all([readChannels(kv), readUntrackedIds(kv)]);
  return shouldIngestChannel(channelId, channels, untracked);
}

export type AnalysisRef = { videoId: string; processedAt: string; date: string };

export function analysisKey(date: string, videoId: string): string {
  return `${KV_ANALYSIS_PREFIX}${date}:${videoId}`;
}

function parseAnalysisKey(name: string): { date: string; videoId: string } | null {
  if (!name.startsWith(KV_ANALYSIS_PREFIX)) return null;
  const rest = name.slice(KV_ANALYSIS_PREFIX.length);
  const i = rest.indexOf(":");
  if (i < 1) return null;
  const date = rest.slice(0, i);
  const videoId = rest.slice(i + 1);
  return date && videoId ? { date, videoId } : null;
}

export async function readAnalysisIndex(kv: Kv): Promise<AnalysisRef[]> {
  const raw = await kv.get(KV_ANALYSIS_INDEX);
  if (raw != null) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        return value.filter((row) => row && row.videoId && row.date);
      }
    } catch { /* rebuild */ }
  }
  const names = await listNames(kv, KV_ANALYSIS_PREFIX);
  const refs: AnalysisRef[] = [];
  for (const name of names) {
    const parsed = parseAnalysisKey(name);
    if (!parsed) continue;
    let processedAt = parsed.date;
    const noteRaw = await kv.get(name);
    if (noteRaw) {
      try {
        const note = JSON.parse(noteRaw);
        if (note?.processedAt) processedAt = note.processedAt;
      } catch { /* date only */ }
    }
    refs.push({ videoId: parsed.videoId, date: parsed.date, processedAt });
  }
  await kv.put(KV_ANALYSIS_INDEX, JSON.stringify(refs));
  return refs;
}

export async function upsertAnalysisIndex(kv: Kv, ref: AnalysisRef): Promise<void> {
  const refs = await readAnalysisIndex(kv);
  const next = [ref, ...refs.filter((row) => row.videoId !== ref.videoId)];
  await kv.put(KV_ANALYSIS_INDEX, JSON.stringify(next));
}

export async function removeFromAnalysisIndex(kv: Kv, videoId: string): Promise<AnalysisRef[]> {
  const refs = await readAnalysisIndex(kv);
  const gone = refs.filter((row) => row.videoId === videoId);
  await kv.put(KV_ANALYSIS_INDEX, JSON.stringify(refs.filter((row) => row.videoId !== videoId)));
  return gone;
}

export async function readAnalyses(kv: Kv, date: string): Promise<unknown[]> {
  const refs = await readAnalysisIndex(kv);
  const wanted = date === "all" ? refs : refs.filter((row) => row.date === date);
  const notes: unknown[] = [];
  for (let i = 0; i < wanted.length; i += 20) {
    const batch = wanted.slice(i, i + 20);
    const rows = await Promise.all(batch.map((row) => kv.get(analysisKey(row.date, row.videoId))));
    for (const raw of rows) {
      if (!raw) continue;
      try {
        notes.push(JSON.parse(raw));
      } catch { /* skip */ }
    }
  }
  if (date === "all") {
    notes.sort((a, b) => {
      const ta = new Date((a as { processedAt?: string }).processedAt || 0).getTime();
      const tb = new Date((b as { processedAt?: string }).processedAt || 0).getTime();
      return tb - ta;
    });
  }
  return notes;
}

/** Save a note AND complete its inbox item in one store operation.
 *  "Processed means out of pending" is the Worker's rule (issue #5): both note
 *  writers (helper Process, Gemini Web import) stop removing pending rows
 *  themselves. Completion removes the pending row without discarding it —
 *  re-saves and history notes must not land in the discarded list. Returns how
 *  many pending rows were actually removed. */
export async function completeInboxNote(
  kv: Kv,
  video: { videoId: string; processedAt?: string }
): Promise<{ removedFromPending: number }> {
  const dateKey = video.processedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const removed = await serialize(async () => {
    const current = await readPending(kv);
    const hadRow = current.some((v) => v.videoId === video.videoId);
    if (hadRow) await writePendingList(kv, removePendingIds(current, [video.videoId]));
    await kv.put(analysisKey(dateKey, video.videoId), JSON.stringify(video), { expirationTtl: NOTE_TTL_SECONDS });
    await kv.put(KV_PROCESSED_PREFIX + video.videoId, "1");
    await upsertAnalysisIndex(kv, {
      videoId: video.videoId,
      date: dateKey,
      processedAt: video.processedAt || dateKey,
    });
    return hadRow ? 1 : 0;
  });
  return { removedFromPending: removed };
}

/** Notes expire from KV after 30 days, same as before the shared completion. */
const NOTE_TTL_SECONDS = 60 * 60 * 24 * 30;
