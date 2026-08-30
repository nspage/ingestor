import { config } from "dotenv";
config({ override: true });
import { getLatestVideoIds, getTranscriptSample } from "./utils";
import { GEMINI_MODEL } from "./config";
import { getCategorisationPromptDetails } from "./kv-client";
import { completeText } from "./llm-client";
import { DEFAULT_CATEGORISATION_PROMPT, canonicalCategory } from "../../worker/src/queue";

// ── Classification Task ──

export async function classifyChannel(payload: { channelId: string; channelName?: string }) {
    const { channelId, channelName } = payload;
    console.log(`[Classifier] Starting classification for: ${channelName || channelId}`);

    // 1. Fetch latest 5 video IDs
    const videoIds = await getLatestVideoIds(channelId, 5);
    if (videoIds.length === 0) {
      console.warn(`[Classifier] No videos found for channel ${channelId}`);
      return { channelId, category: canonicalCategory("Strategy"), reason: "no_videos_found" }; // default fallback
    }

    // 2. Fetch transcript samples (first 3000 chars each to save tokens)
    const samples: string[] = [];
    for (const videoId of videoIds) {
      const sample = await getTranscriptSample(videoId, 3000);
      if (sample) samples.push(sample);
    }

    if (samples.length === 0) {
      console.warn(`[Classifier] Could not fetch any transcripts for channel ${channelId}`);
      return { channelId, category: canonicalCategory("Strategy"), reason: "no_transcripts_found" };
    }

    // 3. Prepare the prompt (category list comes from the worker vocabulary)
    const concatenatedTranscripts = samples
      .map((s, i) => `--- VIDEO ${i + 1} SNIPPET ---\n${s}`)
      .join("\n\n");

    let customPrompt = "";
    let customModel = "";
    try {
      const details = await getCategorisationPromptDetails();
      customPrompt = details.prompt;
      customModel = details.model;
    } catch (e) {
      console.warn(`[Classifier] Failed to fetch custom prompt from KV, using default.`, e);
    }

    const basePrompt = customPrompt || DEFAULT_CATEGORISATION_PROMPT;
    const finalModel = customModel || GEMINI_MODEL;
    let prompt = "";
    if (basePrompt.includes("{{CONTENT_SNIPPETS}}")) {
      prompt = basePrompt.replace("{{CONTENT_SNIPPETS}}", concatenatedTranscripts);
    } else if (basePrompt.includes("{{content_snippets}}")) {
      prompt = basePrompt.replace("{{content_snippets}}", concatenatedTranscripts);
    } else {
      prompt = `${basePrompt}\n\nCONTENT SNIPPETS:\n${concatenatedTranscripts}`;
    }

    console.log(`[Classifier] Classifying with ${finalModel}...`);
    const { text } = await completeText({
      model: finalModel,
      prompt,
      maxTokens: 1024,
      temperature: 0.1,
    });
    
    // Validation: map the response onto the vocabulary; unknown stays unknown.
    const finalCategory = canonicalCategory(text);

    console.log(`[Classifier] Result: ${finalCategory || "(not in vocabulary)"}`);

    return { 
      channelId, 
      channelName, 
      category: finalCategory,
      rawResponse: text.trim() 
    };
}
