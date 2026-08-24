import { config } from "dotenv";
config({ override: true });
import { getLatestVideoIds, getTranscriptSample } from "../utils";
import { GEMINI_MODEL } from "./config";
import { getCategorisationPromptDetails } from "./kv-client";

// ── Gemini API Helper (Copied from process-video.ts for consistency) ──

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
        generationConfig: { maxOutputTokens: 1024, temperature: 0.1 }, // Lower temperature for classification accuracy
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

// ── Classification Task ──

export async function classifyChannel(payload: { channelId: string; channelName?: string }) {
    const { channelId, channelName } = payload;
    console.log(`[Classifier] Starting classification for: ${channelName || channelId}`);

    // 1. Fetch latest 5 video IDs
    const videoIds = await getLatestVideoIds(channelId, 5);
    if (videoIds.length === 0) {
      console.warn(`[Classifier] No videos found for channel ${channelId}`);
      return { channelId, category: "Strategy", reason: "no_videos_found" }; // Default fallback
    }

    // 2. Fetch transcript samples (first 3000 chars each to save tokens)
    const samples: string[] = [];
    for (const videoId of videoIds) {
      const sample = await getTranscriptSample(videoId, 3000);
      if (sample) samples.push(sample);
    }

    if (samples.length === 0) {
      console.warn(`[Classifier] Could not fetch any transcripts for channel ${channelId}`);
      return { channelId, category: "Strategy", reason: "no_transcripts_found" };
    }

    // 3. Prepare the prompt
    const concatenatedTranscripts = samples
      .map((s, i) => `--- VIDEO ${i + 1} SNIPPET ---\n${s}`)
      .join("\n\n");

    const defaultPromptBase = `You are an expert Content Strategist. Based on the following transcript snippets from a YouTube channel, classify this channel into EXACTLY one of the following five categories.

CATEGORIES:
1. **Tactical**: Practical "how-to" guides, technical tutorials, software walkthroughs, coding, or step-by-step Standard Operating Procedures (SOPs).
2. **Ideation**: Brainstorming new business ideas, identifying market "white space," niche hunting, or exploring consumer trends.
3. **Strategy**: High-level frameworks, mental models, macro-economic shifts, philosophical "why" behind business decisions, or long-term industry positioning.
4. **News/Roundup**: Summaries of current events, industry headlines, weekly updates, or commentary on trending topics.
5. **second brain**: Personal Knowledge Management (PKM), productivity systems, note-taking methodologies, or "linking your thinking" workflows.

Instructions:
- Return ONLY the category name (one of: Tactical, Ideation, Strategy, News/Roundup, second brain).
- If the channel fits multiple categories, pick the most dominant one.`;

    let customPrompt = "";
    let customModel = "";
    try {
      const details = await getCategorisationPromptDetails();
      customPrompt = details.prompt;
      customModel = details.model;
    } catch (e) {
      console.warn(`[Classifier] Failed to fetch custom prompt from KV, using default.`, e);
    }

    const basePrompt = customPrompt || defaultPromptBase;
    const finalModel = customModel || GEMINI_MODEL;
    let prompt = "";
    if (basePrompt.includes("{{CONTENT_SNIPPETS}}")) {
      prompt = basePrompt.replace("{{CONTENT_SNIPPETS}}", concatenatedTranscripts);
    } else if (basePrompt.includes("{{content_snippets}}")) {
      prompt = basePrompt.replace("{{content_snippets}}", concatenatedTranscripts);
    } else {
      prompt = `${basePrompt}\n\nCONTENT SNIPPETS:\n${concatenatedTranscripts}`;
    }

    // 4. Call Gemini
    console.log(`[Classifier] Calling Gemini (${finalModel}) for classification...`);
    const { text } = await callGemini(prompt, finalModel);
    
    // Clean up response (Gemini sometimes adds markdown or whitespace)
    const category = text.trim().replace(/[*_]/g, "");
    
    // Validation: ensure the returned category is one of the allowed ones
    const validCategories = ["Tactical", "Ideation", "Strategy", "News/Roundup", "second brain"];
    const finalCategory = validCategories.find(c => c.toLowerCase() === category.toLowerCase()) || "Strategy";

    console.log(`[Classifier] Result: ${finalCategory}`);

    return { 
      channelId, 
      channelName, 
      category: finalCategory,
      rawResponse: category 
    };
}
