import "dotenv/config";
import { YoutubeTranscript } from "youtube-transcript";
import { GEMINI_MODEL, SHORT_TEXT_CATEGORY, type CategoryVisualAssets, type ContentCategory, type ProcessedVideo, type VisualAsset } from "./config";
import { removePendingVideos, saveProcessedVideo, incrementDailyCost, getCategories } from "./kv-client";
import { sendTelegramDocument, normalizeCues, fetchVideoDescription, isPlaceholderChannelName, resolveVideoIdentity, resolveChannelInfo } from "../utils";
import { calculateCost, completeText, completeVisual } from "./llm-client";

export type ProcessVideoInput = {
  videoId: string;
  title: string;
  channelId: string;
  channelName: string;
  category: string;
  publishedAt: string;
  videoUrl: string;
  addedAt: string;
  sendToTelegram?: boolean;
};

// ── Prompt Builder ──

function buildPrompt(transcript: string, title: string, channel: string, category: ContentCategory, promptTemplate?: string): string {
  const defaultPrompt = `Analyze the transcript and provide:
- Speaker identification with their roles/affiliations
- Key topics developed in the transcript
Identify and categorize the information within the transcript according to the following archetypes. If a category is not present, skip it:
1. **Mental Models (The 'Why'):** Philosophical shifts or conceptual lenses used to view the problem. 
2. **Frameworks & Systems (The 'Structure'):** Repeatable processes, 2x2 matrices, or step-by-step methodologies developed by the speaker. 
3. **Tactical Tutorials (The 'How'):** Click-by-click or action-by-action instructions. Provide these as a numbered "SOP" (Standard Operating Procedure).
4. **Deep Dives (The 'Mechanics'):** High-density technical explanations or granular breakdowns of a specific system 
5. **Interview Insights (The 'Nuance'):** If this is an interview, extract the non-obvious wisdom gained from the back-and-forth, including the speaker's personal "war stories."
6. **Case Studies (The 'Proof'):** Real-world examples cited. Detail the Challenge, the Intervention, and the Result.
7. **Heuristics & Red Flags (The 'Shortcuts'):** Rules of thumb, "if-this-then-that" shortcuts, and warning signs to watch out for.
8. **Contrarian Takes (The 'Alpha'):** Ideas mentioned that go against the "common wisdom" of the industry.
9. **Resource Stack (The 'Tools'):** A list of all software, books, hardware, or third-party services mentioned as essential.`;

  const template = promptTemplate || defaultPrompt;

  return `You are a world-class Knowledge Engineer. Analyze this YouTube transcript and synthesize it into a high-signal markdown document.

# VIDEO: ${title}
CHANNEL: ${channel}
CATEGORY: ${category}

---
${template}

---
TRANSCRIPT:
${transcript.slice(0, 30000)}`;
}

// ── Visual locate pass ──

const VISUAL_ASSET_TYPES = ["slide", "diagram", "ui", "code", "chart", "product", "on_screen_text"];
// Unit of work is a unique on-screen object, not a frame — zoom/pan on the same diagram is one asset
const MAX_VISUAL_ASSETS = 8;
// Runaway guard per reconstruction; a full diagram/table should sit well under this
const MAX_RECONSTRUCTION_CHARS = 4000;
const VISUAL_MODEL = "gemini-3.7-flash";

const VISUAL_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    assets: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          t: { type: "STRING", description: "Canonical/overview timestamp MM:SS (or H:MM:SS for long videos) — the first moment the object is fully readable" },
          tEnd: { type: "STRING", description: "Optional end timestamp MM:SS/H:MM:SS when the video leaves this object" },
          type: { type: "STRING", enum: VISUAL_ASSET_TYPES },
          title: { type: "STRING" },
          reconstruction: {
            type: "STRING",
            description: "The full on-screen object rebuilt as markdown: tables, bullets, code, field lists, diagram maps. Assemble from the whole zoom/pan sequence, not one crop. Never prose commentary.",
          },
          completeness: { type: "STRING", enum: ["full", "partial"], description: "partial when some region of the object was never shown legibly" },
          confidence: { type: "NUMBER" },
        },
        required: ["t", "type", "title", "reconstruction", "confidence"],
      },
    },
  },
  required: ["assets"],
};

function buildVisualPrompt(category: string, kinds: string[]): string {
  return `You are reconstructing knowledge that exists only on screen in a YouTube video, for a personal notes tool.

CATEGORY: ${category}
ASSET TYPES TO KEEP: ${kinds.join(", ")}

The unit of work is a UNIQUE VISUAL OBJECT, not a frame. A slide or diagram that stays on screen while the speaker zooms, pans, highlights, or talks over it is ONE asset — camera motion does not create a new one. Watch the whole sequence and reconstruct the FULL object (every labeled region, node, row, field), not the zoomed subset. If a region is never shown legibly, say so inside the reconstruction instead of inventing it.

For each unique object return:
- t: the best overview timestamp (or the first moment the object is fully readable); tEnd when they leave it
- type: one of ${VISUAL_ASSET_TYPES.join(", ")}
- title: the object's own heading/name (use the name the speaker or the screen gives it)
- reconstruction: the object rebuilt as markdown, by type:
  * chart → a real markdown table (headers + rows). Never a prose summary of the chart.
  * slide → heading + bullets exactly as written on the slide.
  * code → fenced code block with the language if obvious.
  * ui → nested field/label list (e.g. "Name: …", "Runtime: Claude/Codex/Ollama"), not a description of someone using it.
  * diagram → nested markdown map of labeled regions, nodes, and relationships. Mermaid only for a simple fully-visible flowchart; otherwise nested lists. Assemble from the zoom/pan sequence.
  * product → keep only if readable spec/text on screen is worth keeping as a list.
  * on_screen_text → the full readable text in reading order as markdown a human can paste (prompt, email, tweet, notes, config). If they scroll one continuous document, that is ONE asset assembled from the whole scroll. Preserve line breaks. Never summarize.
- completeness: "partial" if any region was never legible.

Never write "the speaker compares / walks through / demonstrates" — the transcript already has the narration; the reconstruction must add structure the transcript does not have (a table, field list, code block, slide hierarchy, or diagram map). Skip talking heads, b-roll, intro/outro cards, lower thirds, thumbnails, and UI shots whose reconstruction would just restate what the speaker says in prose. If you cannot reconstruct the object, omit it.

Return at most ${MAX_VISUAL_ASSETS} assets, strongest first; prefer one complete diagram over eight fragments. Zero assets is a success. The transcript is provided only so you avoid duplicating spoken content and can name objects the speaker names — do not caption what the speaker says.`;
}

function isVisualFirst(cat?: { name?: string; visualAssets?: CategoryVisualAssets }): boolean {
  if (!cat?.visualAssets?.enabled || !cat.visualAssets.kinds?.length) return false;
  if (String(cat.name || "").toLowerCase() === SHORT_TEXT_CATEGORY) return true;
  return cat.visualAssets.kinds.every((k) => k === "on_screen_text");
}

function parseTimestampToSeconds(t: string): number {
  const parts = String(t || "").split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p)) || parts.length < 2) return -1;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

/** JSON.parse with a salvage pass for MAX_TOKENS cuts: back up to the last structurally
 *  complete asset and close the `{"assets":[...]}` envelope, keeping valid assets. */
function parseTruncatedJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch { /* fall through to repair */ }
  let s = raw.replace(/[\s,]+$/, "");
  for (let attempt = 0; attempt < 16; attempt++) {
    const idx = s.lastIndexOf("}");
    if (idx <= 0) break;
    s = s.slice(0, idx + 1);
    try {
      return JSON.parse(s + "]}");
    } catch { /* try an earlier object boundary */ }
    s = s.slice(0, -1);
  }
  return undefined;
}

/** Parse + sanitize the locate response; drops junk the model added despite the schema/prompt. */
function parseVisualAssets(raw: string): { assets: VisualAsset[]; parseError?: string } {
  const data = parseTruncatedJson(raw);
  if (!data || typeof data !== "object") {
    return { assets: [], parseError: "JSON parse failed (including truncation salvage)" };
  }
  const list = Array.isArray(data?.assets) ? data.assets : [];
  const assets: VisualAsset[] = [];
  const seenTs: number[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const seconds = parseTimestampToSeconds(item.t);
    if (seconds < 0) continue;
    // Safety net for exact dupes only — real identity (same object under camera motion) is the model's job
    if (seenTs.some((s) => Math.abs(s - seconds) < 3)) continue;
    seenTs.push(seconds);
    if (typeof item.title !== "string" || !item.title.trim()) continue;
    if (!VISUAL_ASSET_TYPES.includes(item.type)) continue;
    // Reconstruction is the payload — an asset without one is a caption, not knowledge
    if (typeof item.reconstruction !== "string" || !item.reconstruction.trim()) continue;
    assets.push({
      t: String(item.t),
      tEnd: item.tEnd && parseTimestampToSeconds(item.tEnd) >= 0 ? String(item.tEnd) : undefined,
      type: item.type,
      title: item.title.trim().slice(0, 120),
      reconstruction: item.reconstruction.trim().slice(0, MAX_RECONSTRUCTION_CHARS),
      completeness: item.completeness === "full" || item.completeness === "partial" ? item.completeness : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
    });
  }
  return { assets: assets.slice(0, MAX_VISUAL_ASSETS) };
}
/**
 * Appendix of reconstructed on-screen objects. One subsection per unique object; the
 * reconstruction goes in as raw markdown so tables/code/lists render in every consumer
 * of `analysis` (email, Telegram, side panel). Full YouTube links — never relative image refs.
 */
function buildVisualAppendix(videoUrl: string, assets: VisualAsset[]): string {
  const sections = assets.map((a) => {
    const seconds = parseTimestampToSeconds(a.t);
    const link = seconds >= 0 ? `${videoUrl}&t=${seconds}s` : videoUrl;
    const meta = [`[${a.t}](${link})`, a.type, a.completeness === "partial" ? "partial" : ""].filter(Boolean).join(" · ");
    return `### ${a.title}\n\n${meta}\n\n${a.reconstruction.trim()}\n`;
  });
  return `\n\n## On screen\n\n${sections.join("\n")}`;
}

/**
 * Multimodal reconstruct pass: Gemini watches the video (public YouTube URL) and returns
 * unique on-screen objects as markdown reconstructions.
 * Never throws for expected failures — returns a status the caller can record on the note.
 */
async function locateVisualAssets(
  video: ProcessVideoInput,
  transcript: string,
  visual: CategoryVisualAssets
): Promise<{ assets: VisualAsset[]; status: "empty" | "skipped" | "failed"; cost: number; usage?: any; note?: string }> {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const model = visual.model || VISUAL_MODEL;
  // HIGH costs 4x tokens per frame; only meaningful when OCR-heavy kinds are requested
  const ocrHeavy = visual.kinds.some((k) => k === "code" || k === "slide" || k === "chart" || k === "diagram" || k === "on_screen_text");
  const mediaResolution = (visual.mediaResolution === "high" || ocrHeavy) ? "high" : "default";
  // Markdown reconstructions are bulky; thinking draws from the same output budget
  const maxOutputTokens = 32768;

  try {
    const { text, usage, finishReason } = await completeVisual({
      model,
      youtubeUrl: videoUrl,
      prompt: `${buildVisualPrompt(video.category, visual.kinds)}\n\nTRANSCRIPT (so you avoid duplicating spoken content and can name objects the speaker names):\n${transcript.slice(0, 30000)}`,
      schema: VISUAL_RESPONSE_SCHEMA,
      maxTokens: maxOutputTokens,
      thinking: "low",
      mediaResolution,
    });

    if (!text || finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
      return { assets: [], status: "skipped", cost: 0, usage, note: `Gemini refused or returned nothing (finishReason: ${finishReason || "empty"})` };
    }
    // A truncation may still hold complete assets before the cut — keep them instead of failing to zero
    if (finishReason === "MAX_TOKENS") {
      const { assets, parseError } = parseVisualAssets(text);
      const note = parseError
        ? `Visual response truncated (MAX_TOKENS), no complete JSON to salvage — retune schema/thinkingLevel`
        : `Visual response truncated (MAX_TOKENS) — kept ${assets.length} complete asset(s)`;
      return { assets, status: assets.length ? "empty" : "failed", cost: calculateCost(model, usage), usage, note };
    }

    const { assets, parseError } = parseVisualAssets(text);
    if (parseError) {
      return { assets: [], status: "failed", cost: calculateCost(model, usage), usage, note: parseError };
    }
    return { assets, status: "empty", cost: calculateCost(model, usage), usage, note: undefined };
  } catch (err) {
    // Expected failures land here: non-public videos, unavailable preview tier, timeouts, quota
    const msg = err instanceof Error ? err.message : String(err);
    return { assets: [], status: "skipped", cost: 0, note: `Visual pass skipped: ${msg.slice(0, 200)}` };
  }
}

export async function processVideos(payload: { videos: ProcessVideoInput[] }) {
    const { videos } = payload;
    console.log(`Processing ${videos.length} approved video(s)...`);

    const results: Array<{ videoId: string; title: string; status: "success" | "error"; error?: string }> = [];
    let shouldSendBatchTelegram = false;

    // Fetch dynamic categories once per batch
    const categoriesList = await getCategories().catch(() => []);
    const categoriesMap = new Map(categoriesList.map(c => [c.name, { name: c.name, prompt: c.prompt, model: c.model, visualAssets: c.visualAssets }]));

    for (const video of videos) {
      if (isPlaceholderChannelName(video.channelName) || isPlaceholderChannelName(video.title) || !video.title) {
        try {
          const identity = await resolveVideoIdentity(video.videoId);
          if (identity?.title && isPlaceholderChannelName(video.title)) video.title = identity.title;
          if (identity?.channelName && isPlaceholderChannelName(video.channelName)) video.channelName = identity.channelName;
          if (identity?.authorUrl && (!video.channelId || video.channelId === "manual_ingest")) {
            const info = await resolveChannelInfo(identity.authorUrl).catch(() => null);
            if (info?.id) video.channelId = info.id;
            if (info?.name && isPlaceholderChannelName(video.channelName)) video.channelName = info.name;
          }
        } catch (err) {
          console.warn(`  ⚠️ Failed to resolve video identity:`, err);
        }
      }

      console.log(`\n── Processing: "${video.title}" (${video.videoId})`);
      if (video.sendToTelegram) shouldSendBatchTelegram = true;

      try {
        const catConfig = (categoriesMap.get(video.category)
          || [...categoriesMap.values()].find((c) => String(c.name).toLowerCase() === String(video.category || "").toLowerCase())) as { name?: string, prompt: string, model: string, visualAssets?: CategoryVisualAssets } | undefined;
        const visualFirst = isVisualFirst(catConfig);

        // 1. Extract transcript (optional for visual-first Shorts)
        console.log("  📄 Extracting transcript...");
        let segments: Array<{ text: string; offset: number; duration: number }> | undefined;
        try {
          segments = await YoutubeTranscript.fetchTranscript(video.videoId);
        } catch {
          console.warn(`  ⚠️ Default transcript fetch failed, retrying with 'en'...`);
          try {
            segments = await YoutubeTranscript.fetchTranscript(video.videoId, { lang: 'en' });
          } catch (retryError) {
            const finalError = retryError instanceof Error ? retryError.message : String(retryError);
            if (!visualFirst) {
              console.error(`  ❌ Transcript error for ${video.videoId}: ${finalError}`);
              results.push({
                videoId: video.videoId,
                title: video.title,
                status: "error",
                error: `Transcript Fetch Failed: The library couldn't access the captions (often due to YouTube blocking server IPs). Error: ${finalError}`
              });
              continue;
            }
            console.warn(`  ⚠️ No captions; continuing visual-first (${finalError})`);
          }
        }

        const cues = segments ? normalizeCues(segments) : [];
        const transcript = cues.map((t) => t.text).join(" ");
        if (!visualFirst && (!transcript || transcript.length < 100)) {
          results.push({ videoId: video.videoId, title: video.title, status: "error", error: "Transcript too short or empty" });
          continue;
        }
        console.log(`  📄 Transcript: ${transcript.length} chars (${cues.length} cues)`);

        const incomingDesc = typeof (video as { description?: string }).description === "string"
          ? (video as { description?: string }).description || ""
          : "";
        const fetchedDesc = await fetchVideoDescription(video.videoId);
        const description = fetchedDesc || (incomingDesc.length > 300 ? incomingDesc : "");

        const modelToUse = catConfig?.model || GEMINI_MODEL;
        const promptTemplate = catConfig?.prompt;
        // Visual-first (short text extract): the screen is the note. Transcript analysis invents "conceptual" prompts.
        const runText = !visualFirst && transcript.length >= 100;
        let analysis = "";
        let usage: any = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

        if (runText) {
          console.log("  🤖 Analyzing...");
          const result = await completeText({
            model: modelToUse,
            prompt: buildPrompt(transcript, video.title, video.channelName, video.category as ContentCategory, promptTemplate),
          });
          analysis = result.text;
          usage = result.usage;
          console.log(`  🤖 Analysis: ${analysis.length} chars (Model: ${modelToUse})`);
        } else {
          analysis = `On-screen text from [${video.title}](${video.videoUrl}).\n`;
          console.log(visualFirst
            ? "  🤖 Skipping transcript analysis (visual-first)"
            : "  🤖 Skipping transcript analysis (visual-first, no captions)");
        }

        let videoCost = calculateCost(modelToUse, usage);
        let totalTokens = usage?.totalTokenCount || 0;
        console.log(`  💰 Cost: $${videoCost.toFixed(4)} (${totalTokens} tokens)`);

        // 2b. Visual locate pass — only for categories with visualAssets.enabled
        let visual: { assets: VisualAsset[]; status: "empty" | "skipped" | "failed"; cost: number; usage?: any; note?: string } | undefined;
        const visualConfig = catConfig?.visualAssets;
        if (visualConfig?.enabled && visualConfig.kinds?.length) {
          console.log(`  🖼️ Visual pass (${visualConfig.model || VISUAL_MODEL}, ${visualConfig.kinds.join("/")})...`);
          visual = await locateVisualAssets(video, transcript, visualConfig);
          videoCost += visual.cost;
          if (visual.usage?.totalTokenCount) totalTokens += visual.usage.totalTokenCount;
          console.log(`  🖼️ Visual: ${visual.assets.length} asset(s), status=${visual.status} $${visual.cost.toFixed(4)}${visual.note ? ` — ${visual.note}` : ""}`);
        }

        await incrementDailyCost(videoCost, totalTokens);

        // 3. Save
        let finalAnalysis = analysis;
        if (visual?.assets.length) finalAnalysis += buildVisualAppendix(video.videoUrl, visual.assets);
        const processed: ProcessedVideo = {
          ...video,
          category: video.category as ContentCategory,
          transcript,
          cues,
          description: description || incomingDesc || undefined,
          descriptionBlock: description || undefined,
          descriptionStatus: description ? "draft" : undefined,
          analysis: finalAnalysis,
          processedAt: new Date().toISOString(),
          assets: visual?.assets.length ? visual.assets : undefined,
          // Status is only meaningful when the pass produced nothing
          visualStatus: visual && !visual.assets.length ? visual.status : undefined,
          visualNote: visual && !visual.assets.length ? visual.note : undefined,
          cost: videoCost,
          usage: {
            totalTokenCount: totalTokens
          }
        } as ProcessedVideo & { cost: number, usage: any };
        await saveProcessedVideo(processed);

        // 4. Telegram notification (if requested)
        if (video.sendToTelegram) {
          const safeTitle = video.title.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 50);
          const filename = `${safeTitle}.md`;
          const caption = `📊 <b>Analysis Complete</b>\n\n🎬 <b>${video.title}</b>\n📺 ${video.channelName} • ${video.category}\n🔗 ${video.videoUrl}\n\n💰 <b>Cost:</b> $${videoCost.toFixed(4)} (${(totalTokens/1000).toFixed(1)}k tokens)`;

          await sendTelegramDocument(filename, finalAnalysis, caption);
        }

        results.push({ videoId: video.videoId, title: video.title, status: "success" });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`  ❌ Error: ${errMsg}`);
        results.push({ videoId: video.videoId, title: video.title, status: "error", error: errMsg });
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    // Remove processed from pending
    const doneIds = results.filter((r) => r.status === "success").map((r) => r.videoId);
    if (doneIds.length > 0) await removePendingVideos(doneIds);

    const ok = results.filter((r) => r.status === "success").length;
    const fail = results.filter((r) => r.status === "error").length;

    return { succeeded: ok, failed: fail, results };
}
