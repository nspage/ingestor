import { ui } from "./panel-state.js";
import { videoChannelLabel, hasRealCategory, needsCategory, videoWatchUrl } from "./video-info.js";

export function geminiPrefillText(video) {
  const videoUrl = videoWatchUrl(video);
  if (!hasRealCategory(video) || needsCategory(video)) return videoUrl;
  const name = String(video.category || "").trim();
  const cat = ui.categories.find((c) => c.name === name)
    || ui.categories.find((c) => c.name && c.name.toLowerCase() === name.toLowerCase());
  const prompt = String(cat?.prompt || "").trim();
  if (!prompt) return videoUrl;
  const channel = videoChannelLabel(video);
  return [
    prompt,
    "",
    "---",
    `VIDEO: ${video.title || video.videoId}`,
    channel ? `CHANNEL: ${channel}` : null,
    `URL: ${videoUrl}`,
  ].filter((line) => line !== null).join("\n");
}

export function bindGeminiOpen(session, tabId) {
  const next = { ...session, tabId };
  chrome.storage.local.set({ geminiSession: next });
  chrome.storage.session.get("geminiTabSessions", (data) => {
    const all = data.geminiTabSessions || {};
    all[String(tabId)] = next;
    chrome.storage.session.set({ geminiTabSessions: all });
  });
}

export function openInGemini(video, fromPending) {
  const text = geminiPrefillText(video);
  const snapshot = {
    videoId: video.videoId,
    title: video.title,
    channelId: video.channelId,
    channelName: videoChannelLabel(video) || video.channelName,
    category: video.category,
    publishedAt: video.publishedAt,
    videoUrl: videoWatchUrl(video),
    addedAt: video.addedAt,
    duration: video.duration,
    processedAt: video.processedAt,
    sourceVideoIds: video.sourceVideoIds,
    // Keep writer/visual state so an Undo restore puts back what was there (issue #5)
    ...(video.analysisSource ? { analysisSource: video.analysisSource } : {}),
    ...(Array.isArray(video.assets) && video.assets.length ? { assets: video.assets } : {}),
    ...(video.visualStatus ? { visualStatus: video.visualStatus, ...(video.visualNote ? { visualNote: video.visualNote } : {}) } : {}),
    ...(video.branchSource ? { branchSource: video.branchSource } : {}),
    ...(video.geminiChatUrl ? { geminiChatUrl: video.geminiChatUrl } : {}),
  };
  const session = {
    videoId: video.videoId,
    tabId: null,
    autoImported: false,
    fromPending: !!fromPending,
    processedAt: fromPending ? null : video.processedAt,
    video: snapshot,
  };
  chrome.storage.local.set({
    geminiPrefill: text,
    geminiSession: session,
  }, () => {
    chrome.tabs.create({ url: "https://gemini.google.com/app", active: false }, (tab) => {
      if (tab?.id) bindGeminiOpen(session, tab.id);
    });
  });
}
