export type PendingVideo = {
  videoId: string;
  title?: string;
  channelId?: string;
  channelName?: string;
  category?: string;
  publishedAt?: string;
  videoUrl?: string;
  addedAt?: string;
  duration?: string;
  description?: string;
  needsCategory?: boolean;
  [key: string]: unknown;
};

export type TrackedChannel = {
  id: string;
  name: string;
  category: string;
  [key: string]: unknown;
};

export const PLACEHOLDER_CHANNEL_NAMES = [
  "",
  "unknown",
  "unknown channel",
  "visit source",
  "youtube video feed",
  "youtube",
  "untitled",
];

export const SHORT_TEXT_CATEGORY = "short text extract";
export const MIN_PENDING_SECONDS = 180;

/** The one category vocabulary. Classifiers, the seed defaults, and the extension
 *  copies (chrome-extension/app/categories.js, content.js) all speak these names —
 *  worker/test/categories-match.test.ts keeps the copies equal. */
export const CATEGORY_VOCABULARY: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: "Tactical",
    description: `Practical "how-to" guides, technical tutorials, software walkthroughs, coding, or step-by-step Standard Operating Procedures (SOPs).`,
  },
  {
    name: "Ideation",
    description: `Brainstorming new business ideas, identifying market "white space," niche hunting, or exploring consumer trends.`,
  },
  {
    name: "Strategy",
    description: `High-level frameworks, mental models, macro-economic shifts, philosophical "why" behind business decisions, or long-term industry positioning.`,
  },
  {
    name: "News/Roundup",
    description: `Summaries of current events, industry headlines, weekly updates, or commentary on trending topics.`,
  },
  {
    name: "second brain",
    description: `Personal Knowledge Management (PKM), productivity systems, note-taking methodologies, or "linking your thinking" workflows.`,
  },
  {
    name: "short text extract",
    description: `Shorts and clips where the value is on-screen text (prompts, emails, tweets, notes the OP scrolls through), not spoken explanation.`,
  },
];

export const CATEGORY_NAMES: readonly string[] = CATEGORY_VOCABULARY.map((c) => c.name);

/** Map a raw LLM response or payload string onto the vocabulary; "" when it is not one. */
export function canonicalCategory(value: string | undefined | null): string {
  const name = String(value || "")
    .trim()
    .replace(/[*_]/g, "");
  if (!name) return "";
  const lower = name.toLowerCase();
  return CATEGORY_NAMES.find((c) => c.toLowerCase() === lower) || "";
}

const DEFAULT_CATEGORISATION_PROMPT = `You are an expert Content Strategist. Based on the following transcript snippets from a YouTube channel, classify this channel into EXACTLY one of the following ${CATEGORY_VOCABULARY.length} categories.

CATEGORIES:
${CATEGORY_VOCABULARY.map((c, i) => `${i + 1}. **${c.name}**: ${c.description}`).join("\n")}

Instructions:
- Return ONLY the category name (one of: ${CATEGORY_NAMES.join(", ")}).
- If the channel fits multiple categories, pick the most dominant one.`;

export { DEFAULT_CATEGORISATION_PROMPT };

/** Seed for a fresh KV `categories` store — the classifier vocabulary with their prompts.
 *  The live KV list (edited in the Categories UI) always wins over this. */
export const DEFAULT_CATEGORIES: Array<{
  name: string;
  model: string;
  prompt: string;
  visualAssets?: { enabled: boolean; kinds: string[]; model: string; mediaResolution: string; materialize: string };
}> = [
  {
    name: "Tactical",
    model: "gemini-3.1-flash-lite",
    prompt: `**Analyze the transcript and provide:**

- **Speaker identification** with their roles/affiliations
- **Key topics** developed in the transcript
- **Glossary** of specialized technical terms

**Identify and categorize the information within the transcript according to the following tactical archetypes. If a category is not present, skip it. Do not attempt to extract broad philosophical theories or market ideation:**

1. **The Goal/Outcome:** What is the exact end-state or final product being built in this tutorial?
2. **Resource Stack (The 'Tools'):** A list of all software, coding libraries, hardware, hosting platforms, or third-party services mentioned as essential to complete the task.
3. **Tactical Tutorials (The 'How'):** Click-by-click or action-by-action instructions. Provide these as a numbered "SOP" (Standard Operating Procedure). If code, technical logic, or a workflow is mentioned, summarize the technical flow clearly.
4. **Deep Dives (The 'Mechanics'):** High-density technical explanations or granular breakdowns of a specific system, feature, or tool configuration.
5. **Heuristics & Pitfalls (The 'Shortcuts'):** Rules of thumb, warning signs, and what the speaker explicitly says _not_ to do during execution.`,
  },
  {
    name: "Ideation",
    model: "gemini-3.1-flash-lite",
    prompt: `**Analyze the transcript and provide:**

- **Speaker identification** with their roles/affiliations
- **Key topics** developed in the transcript
- **Glossary** of specialized terms

**Identify and categorize the information within the transcript according to the following ideation archetypes. If a category is not present, skip it. Do not attempt to extract click-by-click tactical SOPs or highly technical deep dives:**

1. **White Space Opportunities:** The specific markets, unaddressed friction points, or new business ideas being pitched and brainstormed.
2. **Target Audience / Niche:** The exact high-affinity groups, subcultures, or demographics the ideas are built for.
3. **Contrarian Takes (The 'Alpha'):** Ideas or market positioning mentioned that go against the "common wisdom" of the industry.
4. **Case Studies (The 'Proof'):** Real-world examples, startups, or creators cited by the speakers that validate their ideas (Detailing the Challenge, the Intervention, and the Result if applicable).
5. **Mental Models (The 'Why'):** The conceptual lenses used to view consumer behavior or market trends.`,
  },
  {
    name: "Strategy",
    model: "gemini-3.1-flash-lite",
    prompt: `**Analyze the transcript and provide:**

- **Speaker identification** with their roles/affiliations
- **Key topics** developed in the transcript
- **Glossary** of specialized terms

**Identify and categorize the information within the transcript according to the following strategic archetypes. If a category is not present, skip it. Do not attempt to create step-by-step tactical SOPs:**

1. **Mental Models (The 'Why'):** Philosophical shifts, paradigm changes (e.g., the "Old Way vs. New Way" transition), or conceptual lenses used by the speaker to view the industry or problem.
2. **Frameworks & Systems (The 'Structure'):** High-level organizational concepts, 2x2 matrices, or strategic methodologies developed by the speaker to navigate industry transitions.
3. **Heuristics & Red Flags (The 'Shortcuts'):** Rules of thumb, warning signs to watch out for, and high-level principles for strategic decision-making.
4. **Contrarian Takes (The 'Alpha'):** Broad ideas or market positioning mentioned that go against the "common wisdom" of the industry.
5. **Strategic Next Steps:** High-level advice on how to position oneself, a team, or a product for the macro shifts discussed in the transcript.
`,
  },
  {
    name: "News/Roundup",
    model: "gemini-3.1-flash-lite",
    prompt: `**Analyze the transcript and provide:**

- **Speaker identification** with their roles/affiliations
- **Key topics** developed in the transcript (acting as the main headlines discussed)
- **Glossary** of specialized terms

**Identify and categorize the information within the transcript according to the following roundup archetypes. If a category is not present, skip it. Do not attempt to create step-by-step tactical SOPs or extract deep philosophical mental models:**

1. **Deep Dives (The 'Mechanics'):** Granular breakdowns and clear summaries of the specific news stories, current events, or industry updates discussed.
2. **Resource Stack (The 'Tools'):** A list of all links, new software, hardware, third-party services, or platforms mentioned in the news roundup.
3. **Contrarian Takes (The 'Alpha') (Optional):** If the speakers offer a unique or contrary opinion on a current news item that goes against the "common wisdom" of the industry.
`,
  },
  {
    name: "second brain",
    model: "gemini-3.1-flash-lite",
    prompt: "Analyze the transcript and provide key insights.",
  },
  {
    name: SHORT_TEXT_CATEGORY,
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

export function categoryAllowsShorts(
  category: string | undefined,
  categories: Array<{ name?: string; visualAssets?: { enabled?: boolean; kinds?: string[] } }> = []
): boolean {
  const name = String(category || "").trim().toLowerCase();
  if (name === SHORT_TEXT_CATEGORY) return true;
  const cat = categories.find((c) => String(c.name || "").trim().toLowerCase() === name);
  const kinds = cat?.visualAssets?.kinds || [];
  return !!(cat?.visualAssets?.enabled && kinds.includes("on_screen_text"));
}

export function decodeHtmlEntities(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function canonicalChannelId(id: string | undefined | null): string {
  return String(id || "").trim();
}

export function isPlaceholderChannelName(name: string | undefined | null): boolean {
  const trimmed = decodeHtmlEntities(String(name || "")).trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_CHANNEL_NAMES.includes(trimmed.toLowerCase())) return true;
  if (/^channel-\d+$/i.test(trimmed)) return true;
  return false;
}

/** Display name from the KV record only — never from a hardcoded channel list. */
export function displayChannelName(channel: { id?: string; name?: string }): string {
  const id = canonicalChannelId(channel.id);
  const name = decodeHtmlEntities(String(channel.name || "")).trim();
  if (!isPlaceholderChannelName(name)) return name;
  return id;
}

export function mergePending(
  fromList: PendingVideo[],
  fromKeys: PendingVideo[],
  discardedIds: Iterable<string>
): PendingVideo[] {
  const discarded = new Set([...discardedIds].filter(Boolean));
  const byId = new Map<string, PendingVideo>();
  for (const video of fromList || []) {
    if (!video?.videoId || discarded.has(video.videoId)) continue;
    byId.set(video.videoId, video);
  }
  for (const video of fromKeys || []) {
    if (!video?.videoId || discarded.has(video.videoId)) continue;
    byId.set(video.videoId, video);
  }
  return Array.from(byId.values());
}

export function upsertPending(list: PendingVideo[], video: PendingVideo): PendingVideo[] {
  if (!video?.videoId) return list.slice();
  const next = list.filter((v) => v.videoId !== video.videoId);
  next.push(video);
  return next;
}

export function removePendingIds(list: PendingVideo[], videoIds: Iterable<string>): PendingVideo[] {
  const ids = new Set([...videoIds].filter(Boolean));
  return list.filter((v) => !ids.has(v.videoId));
}

export function applyPatches(list: PendingVideo[], patches: PendingVideo[]): PendingVideo[] {
  if (!patches?.length) return list.slice();
  const byId = new Map(patches.filter((p) => p?.videoId).map((p) => [p.videoId, p]));
  return list.map((video) => {
    const patch = byId.get(video.videoId);
    return patch ? { ...video, ...patch, videoId: video.videoId } : video;
  });
}

export function shouldIngestChannel(
  channelId: string,
  tracked: Array<{ id?: string }>,
  untrackedIds: Iterable<string> = []
): boolean {
  const id = canonicalChannelId(channelId);
  const blocked = new Set([...untrackedIds].map(canonicalChannelId).filter(Boolean));
  if (!id || blocked.has(id)) return false;
  return tracked.some((ch) => canonicalChannelId(ch.id) === id);
}

export function findTrackedChannel(
  channelId: string,
  tracked: TrackedChannel[]
): TrackedChannel | undefined {
  const id = canonicalChannelId(channelId);
  return tracked.find((ch) => canonicalChannelId(ch.id) === id);
}

export function normalizeChannels(channels: TrackedChannel[]): TrackedChannel[] {
  const byId = new Map<string, TrackedChannel>();
  for (const raw of channels || []) {
    const id = canonicalChannelId(raw?.id);
    if (!id) continue;
    const prev = byId.get(id);
    const name = decodeHtmlEntities(String(raw.name || prev?.name || "")).trim();
    byId.set(id, {
      ...prev,
      ...raw,
      id,
      name,
      category: raw.category || prev?.category || "",
    });
  }
  return Array.from(byId.values());
}

export function removeTrackedIds(
  channels: TrackedChannel[],
  channelId: string
): TrackedChannel[] {
  const id = canonicalChannelId(channelId);
  return channels.filter((ch) => canonicalChannelId(ch.id) !== id);
}
