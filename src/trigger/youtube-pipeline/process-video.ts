import "dotenv/config";
import { YoutubeTranscript } from "youtube-transcript";
import { GEMINI_MODEL, type ContentCategory, type ProcessedVideo } from "./config";
import { removePendingVideos, saveProcessedVideo, incrementDailyCost, getCategories } from "./kv-client";
import { sendTelegramDocument, normalizeCues, fetchVideoDescription } from "../utils";

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

// ── Gemini API ──

async function callGemini(prompt: string, model: string = GEMINI_MODEL): Promise<{ text: string, usage: any }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing in .env");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.3 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data: any = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini");
  return { text, usage: data.usageMetadata };
}

function calculateCost(model: string, usage: any): number {
  if (!usage) return 0;
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  
  // Approximate pricing per 1M tokens
  let inputPricePerM = 0.075; // default to Flash
  let outputPricePerM = 0.3;
  
  if (model.includes("pro")) {
    inputPricePerM = 1.25;
    outputPricePerM = 5.0;
  } else if (model.includes("lite")) {
    inputPricePerM = 0.0375;
    outputPricePerM = 0.15;
  }
  
  return (inputTokens * inputPricePerM + outputTokens * outputPricePerM) / 1000000;
}

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

export async function processVideos(payload: { videos: ProcessVideoInput[] }) {
    const { videos } = payload;
    console.log(`Processing ${videos.length} approved video(s)...`);

    const results: Array<{ videoId: string; title: string; status: "success" | "error"; error?: string }> = [];
    let shouldSendBatchTelegram = false;

    // Fetch dynamic categories once per batch
    const categoriesList = await getCategories().catch(() => []);
    const categoriesMap = new Map(categoriesList.map(c => [c.name, { prompt: c.prompt, model: c.model }]));

    for (const video of videos) {
      // If the title is the placeholder "YouTube video feed" or empty, try to resolve it from YouTube OEmbed
      if (!video.title || video.title === "YouTube video feed" || video.title === "Untitled") {
        try {
          console.log(`  🌐 Resolving video title dynamically via OEmbed for ${video.videoId}...`);
          const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(video.videoUrl)}&format=json`;
          const r = await fetch(oembedUrl);
          if (r.ok) {
            const d: any = await r.json();
            if (d.title) {
              video.title = d.title;
              console.log(`  🌐 Resolved title: "${video.title}"`);
            }
          }
        } catch (err) {
          console.warn(`  ⚠️ Failed to resolve video title dynamically:`, err);
        }
      }

      console.log(`\n── Processing: "${video.title}" (${video.videoId})`);
      if (video.sendToTelegram) shouldSendBatchTelegram = true;

      try {
        // 1. Extract transcript
        console.log("  📄 Extracting transcript...");
        let segments;
        try {
          segments = await YoutubeTranscript.fetchTranscript(video.videoId);
        } catch (initialError) {
          console.warn(`  ⚠️ Default transcript fetch failed, retrying with 'en'...`);
          try {
            segments = await YoutubeTranscript.fetchTranscript(video.videoId, { lang: 'en' });
          } catch (retryError) {
            const finalError = retryError instanceof Error ? retryError.message : String(retryError);
            console.error(`  ❌ Transcript error for ${video.videoId}: ${finalError}`);
            results.push({ 
              videoId: video.videoId, 
              title: video.title, 
              status: "error", 
              error: `Transcript Fetch Failed: The library couldn't access the captions (often due to YouTube blocking server IPs). Error: ${finalError}` 
            });
            continue;
          }
        }

        const cues = normalizeCues(segments);
        const transcript = cues.map((t) => t.text).join(" ");
        if (!transcript || transcript.length < 100) {
          results.push({ videoId: video.videoId, title: video.title, status: "error", error: "Transcript too short or empty" });
          continue;
        }
        console.log(`  📄 Transcript: ${transcript.length} chars (${cues.length} cues)`);

        const incomingDesc = typeof (video as { description?: string }).description === "string"
          ? (video as { description?: string }).description || ""
          : "";
        const fetchedDesc = await fetchVideoDescription(video.videoId);
        const description = fetchedDesc || (incomingDesc.length > 300 ? incomingDesc : "");

        // 2. Analyze with Gemini
        console.log("  🤖 Analyzing...");
        const catConfig = categoriesMap.get(video.category) as { prompt: string, model: string } | undefined;
        const modelToUse = catConfig?.model || GEMINI_MODEL;
        const promptTemplate = catConfig?.prompt;

        const { text: analysis, usage } = await callGemini(
          buildPrompt(transcript, video.title, video.channelName, video.category as ContentCategory, promptTemplate),
          modelToUse
        );
        console.log(`  🤖 Analysis: ${analysis.length} chars (Model: ${modelToUse})`);

        const videoCost = calculateCost(modelToUse, usage);
        const totalTokens = usage?.totalTokenCount || 0;
        console.log(`  💰 Cost: $${videoCost.toFixed(4)} (${totalTokens} tokens)`);
        
        await incrementDailyCost(videoCost, totalTokens);

        // 3. Save
        const processed: ProcessedVideo = {
          ...video,
          category: video.category as ContentCategory,
          transcript,
          cues,
          description: description || incomingDesc || undefined,
          descriptionBlock: description || undefined,
          descriptionStatus: description ? "draft" : undefined,
          analysis,
          processedAt: new Date().toISOString(),
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
          
          await sendTelegramDocument(filename, analysis, caption);
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
