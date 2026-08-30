import { decodeHtmlEntities, isPlaceholderChannelName } from "./inbox-rules.js";
import { ui } from "./panel-state.js";

export function isSynthNote(video) {
  return String(video?.videoId || "").startsWith("syn_");
}

export function isBranchNote(video) {
  return !!(video?.branchSource) || String(video?.videoId || "").startsWith("brn_");
}

export function isYoutubeNote(video) {
  return !!video?.videoId && !isSynthNote(video) && !isBranchNote(video);
}

export function geminiChatId(url) {
  try {
    const u = new URL(String(url || ""));
    const m = u.pathname.match(/\/app\/([^/]+)\/?$/);
    return m && m[1] ? m[1] : "";
  } catch {
    return "";
  }
}

export function branchParentId(video) {
  return video?.branchSource?.parentVideoId
    || (isBranchNote(video) && video.sourceVideoIds && video.sourceVideoIds[0])
    || "";
}

export function branchRootId(video) {
  let cur = video;
  const seen = new Set();
  while (cur && isBranchNote(cur) && !seen.has(cur.videoId)) {
    seen.add(cur.videoId);
    const pid = branchParentId(cur);
    const parent = ui.history.find((h) => h.videoId === pid);
    if (!parent) return pid || cur.videoId;
    cur = parent;
  }
  return cur?.videoId || video?.videoId;
}

export function branchFamily(video) {
  const rootId = isBranchNote(video) ? branchRootId(video) : video.videoId;
  const root = ui.history.find((h) => h.videoId === rootId) || (!isBranchNote(video) ? video : null);
  const children = ui.history.filter((h) => isBranchNote(h) && branchRootId(h) === rootId);
  const family = [];
  if (root) family.push(root);
  for (const child of children) {
    if (!family.some((n) => n.videoId === child.videoId)) family.push(child);
  }
  if (!family.some((n) => n.videoId === video.videoId)) family.unshift(video);
  family.sort((a, b) => {
    const aBr = isBranchNote(a);
    const bBr = isBranchNote(b);
    if (aBr !== bBr) return aBr ? 1 : -1;
    return String(a.processedAt || "").localeCompare(String(b.processedAt || ""));
  });
  return family;
}

export function branchChipLabel(member) {
  if (!isBranchNote(member)) return "Original";
  const parts = String(member.title || "").split(" — ");
  return parts.length > 1 ? parts.pop() : "Branch";
}

export function videoTime(v) {
  return new Date(v.addedAt || v.publishedAt || 0).getTime();
}

export function channelName(id) {
  return ui.channels.find((c) => c.id === id)?.name || "";
}

export function videoChannelLabel(video) {
  const stored = decodeHtmlEntities(video?.channelName).trim();
  const fromList = decodeHtmlEntities(channelName(video?.channelId)).trim();
  if (!isPlaceholderChannelName(stored)) return stored;
  if (!isPlaceholderChannelName(fromList)) return fromList;
  return "";
}

export function isTrackedVideo(video) {
  const id = String(video?.channelId || "").trim();
  if (!id || id === "manual_ingest") return false;
  return ui.channels.some((c) => c.id === id);
}

export function channelCardName(ch) {
  const name = decodeHtmlEntities(ch.name).trim();
  return isPlaceholderChannelName(name) ? (ch.id || name) : name;
}

export function needsCategory(video) {
  return !!video?.needsCategory;
}

export function hasRealCategory(video) {
  const name = String(video?.category || "").trim();
  return !!name && name !== "uncategorised";
}

export function videoWatchUrl(video) {
  return video.videoUrl || `https://www.youtube.com/watch?v=${video.videoId}`;
}

export function categoryHasVisual(video) {
  const name = String(video.category || "").trim();
  if (!name) return false;
  const cat = ui.categories.find((c) => c.name === name)
    || ui.categories.find((c) => c.name && c.name.toLowerCase() === name.toLowerCase());
  return !!(cat?.visualAssets?.enabled && cat.visualAssets.kinds?.length);
}
