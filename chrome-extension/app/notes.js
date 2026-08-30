import * as api from "./api.js";
import { $, toast, scrollBehavior } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { formatWhen } from "./duration.js";
import { renderMarkdown, renderDescription, renderTranscript, hasTranscript, transcriptCues, transcriptCopyText, isGeminiNote, splitAnalysisTurns, joinAnalysisTurns, escapeHtml } from "./markdown.js";
import { isSynthNote, isBranchNote, isYoutubeNote, branchFamily, branchChipLabel, videoChannelLabel, videoWatchUrl } from "./video-info.js";
import { stashComposer, loadComposer, exitBranchMode, paintTurnNav, paintGeminiThread } from "./gemini-thread.js";
import { setTab } from "./router.js";

export function openDoc(video, mode, opts = {}) {
  if (ui.branchMode) exitBranchMode();
  stashComposer();
  ui.openNote = video;
  ui.docMode = mode;
  ui.descReedit = false;
  ui.descEdit = video.descriptionStatus !== "added";
  ui.prefillOpen = false;
  ui.noteJustOpened = true;
  paintDoc();
  loadComposer(video.videoId);
  setTab("note", opts);
  if (isYoutubeNote(video) && !transcriptCues(video).length) maybeLoadCues(video, false);
}

export function paintDoc() {
  const video = ui.openNote;
  if (!video) return;
  const isNote = ui.docMode !== "transcript";
  const gemini = isNote && isGeminiNote(video);
  const hasCues = transcriptCues(video).length > 0;
  const showTs = !isNote && ui.showTimestamps;
  $("note-title").textContent = video.title || video.videoId;
  paintBranchNav(video);
  $("note-meta").textContent = [
    isSynthNote(video) ? "Synthesis" : isBranchNote(video) ? "Branch" : videoChannelLabel(video),
    video.category,
    formatWhen(video.processedAt),
    video.analysisSource === "gemini-web" ? "Gemini" : "",
    isSynthNote(video) && Array.isArray(video.sourceVideoIds) ? `${video.sourceVideoIds.length} notes` : "",
  ].filter(Boolean).join(" · ");
  $("doc-note").classList.toggle("on", isNote);
  $("doc-transcript").classList.toggle("on", !isNote);
  $("doc-note").setAttribute("aria-selected", isNote ? "true" : "false");
  $("doc-transcript").setAttribute("aria-selected", isNote ? "false" : "true");
  $("doc-transcript").disabled = !hasTranscript(video) && !isYoutubeNote(video);
  $("ts-toggle").classList.toggle("hidden", isNote);
  $("show-ts").disabled = !!video._cuesLoading;
  $("show-ts").checked = ui.showTimestamps;
  $("note-copy").textContent = isNote ? "Copy Markdown" : "Copy Transcript";
  $("note-body").classList.toggle("transcript", !isNote);
  const addedDesc = isNote && video.descriptionStatus === "added" && !!rawDescription(video);
  $("turn-nav").classList.toggle("hidden", !(gemini || addedDesc));
  $("note-thread").classList.toggle("hidden", !gemini);
  $("note-composer").classList.toggle("hidden", !gemini);
  $("note-composer").classList.toggle("tall", !!ui.composerTall);
  $("composer-branch-toggle").classList.toggle("hidden", !video.geminiChatUrl || isSynthNote(video) || isBranchNote(video));
  $("composer-tall").textContent = ui.composerTall ? "Compact" : "Half Height";
  $("note-body").classList.toggle("hidden", gemini);
  if (gemini || addedDesc) paintTurnNav(video, gemini);
  if (gemini) {
    paintGeminiThread(video);
  } else if (isNote) {
    $("note-body").innerHTML = renderMarkdown(video.analysis || "", video) + assetStripHtml(video);
  } else if (video._cuesLoading) {
    $("note-body").innerHTML = "<p class='md-empty'>Loading timestamps…</p>";
  } else {
    $("note-body").innerHTML = renderTranscript(video, showTs);
  }
  const videoLink = $("note-video");
  const hideVideo = isSynthNote(video) || isBranchNote(video);
  videoLink.classList.toggle("hidden", hideVideo);
  if (hideVideo) videoLink.removeAttribute("href");
  else videoLink.href = video.videoUrl || `https://www.youtube.com/watch?v=${video.videoId}`;
  $("note-copy").onclick = async () => {
    const text = isNote ? noteCopyText(video) : transcriptCopyText(video, hasCues);
    await navigator.clipboard.writeText(text);
    toast(isNote ? "Copied markdown" : "Copied transcript");
  };
  paintDescDraft(video, isNote);
}

export function noteCopyText(video) {
  const body = isGeminiNote(video)
    ? joinAnalysisTurns(splitAnalysisTurns(video.analysis, video.analysisTurns))
    : (video.analysis || "");
  const parts = [body];
  const added = addedDescription(video);
  if (added) parts.push(`## Description\n\n${added}`);
  return parts.filter((p) => p !== "").join("\n\n");
}

export function addedDescription(video) {
  if (video?.descriptionStatus !== "added") return "";
  return String(video.description || video.descriptionBlock || "").trim();
}

export function rawDescription(video) {
  const block = video.descriptionBlock || "";
  const desc = video.description || "";
  if (block.startsWith("## From the description")) return desc || block;
  return desc || block;
}

export function persistVideo(video) {
  const { _cuesLoading, _cuesFailed, _descLoading, _descTried, ...rest } = video;
  const hist = ui.history.find((h) => h.videoId === video.videoId);
  if (hist) Object.assign(hist, rest);
  return api.saveProcessed(rest);
}

export function paintDescDraft(video, isNote) {
  const card = $("desc-draft");
  const added = $("desc-added");
  if (!video || !isNote) {
    card.classList.add("hidden");
    added.classList.add("hidden");
    return;
  }
  const text = rawDescription(video);
  const isAdded = video.descriptionStatus === "added";
  const editing = !isAdded || ui.descReedit;
  const showCard = editing && !!text && video.descriptionStatus !== "dismissed";
  const showAdded = isAdded && !ui.descReedit && !!text && ui.descOpen !== false;
  card.classList.toggle("hidden", !showCard);
  added.classList.toggle("hidden", !showAdded);
  if (showAdded) $("desc-added-body").innerHTML = renderDescription(text, video);
  if (!showCard) {
    const stale = (video.descriptionBlock || "").startsWith("## From the description");
    if (!video._descTried && video.descriptionStatus !== "added" && video.descriptionStatus !== "dismissed" && (!video.descriptionStatus || stale || !text)) {
      loadDescription(video);
    }
    return;
  }
  if (video.descriptionBlock !== text) video.descriptionBlock = text;
  if (document.activeElement !== $("desc-editor")) $("desc-editor").value = text;
  $("desc-preview-body").innerHTML = renderDescription(text, video);
  $("desc-editor").classList.toggle("hidden", !ui.descEdit);
  $("desc-preview-body").classList.toggle("hidden", ui.descEdit);
  $("desc-edit").classList.toggle("on", ui.descEdit);
  $("desc-preview").classList.toggle("on", !ui.descEdit);
  $("desc-add").textContent = isAdded ? "Save" : "Add to Note";
  $("desc-dismiss").textContent = isAdded ? "Cancel" : "Dismiss";
}

export function currentDescBlock() {
  return ui.descEdit ? $("desc-editor").value : (ui.openNote?.descriptionBlock || "");
}

export async function loadDescription(video) {
  if (!isYoutubeNote(video)) return;
  if (!video || video._descLoading || video._descTried) return;
  if (video.descriptionStatus === "added" || video.descriptionStatus === "dismissed") return;
  video._descLoading = true;
  try {
    const data = await api.getDescription(video.videoId, video.channelId);
    if (ui.openNote?.videoId !== video.videoId) return;
    if (!String(data.description || "").trim()) throw new Error("empty");
    video.description = data.description;
    video.descriptionBlock = data.description;
    video.descriptionStatus = "draft";
    persistVideo(video).catch(() => {});
  } catch {
    if (ui.openNote?.videoId === video.videoId) video._descTried = true;
  } finally {
    video._descLoading = false;
    if (ui.openNote?.videoId === video.videoId) paintDoc();
  }
}

export async function addDescToNote() {
  const video = ui.openNote;
  if (!video) return;
  const block = currentDescBlock();
  if (!String(block).trim()) { toast("Nothing to add."); return; }
  video.description = block;
  video.descriptionBlock = block;
  const wasAdded = video.descriptionStatus === "added";
  video.descriptionStatus = "added";
  ui.descReedit = false;
  await persistVideo(video);
  toast(wasAdded ? "Saved description" : "Added to note");
  paintDoc();
}

export async function dismissDesc() {
  const video = ui.openNote;
  if (!video) return;
  if (video.descriptionStatus === "added") {
    ui.descReedit = false;
    paintDoc();
    return;
  }
  video.descriptionBlock = currentDescBlock();
  video.descriptionStatus = "dismissed";
  await persistVideo(video);
  paintDoc();
}

export function paintBranchNav(video) {
  const nav = $("branch-nav");
  if (!nav) return;
  const family = branchFamily(video);
  if (family.length < 2) {
    nav.classList.add("hidden");
    nav.innerHTML = "";
    return;
  }
  nav.classList.remove("hidden");
  nav.innerHTML = "";
  family.forEach((member) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "branch-nav-item" + (member.videoId === video.videoId ? " active" : "");
    btn.textContent = branchChipLabel(member);
    btn.onclick = () => openDoc(member, ui.docMode);
    nav.appendChild(btn);
  });
}

export async function maybeLoadCues(video, force) {
  if (!isYoutubeNote(video) || transcriptCues(video).length) return;
  if (!(await api.helperUp())) {
    if (force) toast("Start the helper to fetch the transcript.");
    return;
  }
  await loadCues(video, !force);
}

export async function loadCues(video, quiet = false) {
  if (!video || video._cuesLoading || transcriptCues(video).length) return;
  video._cuesLoading = true;
  try {
    const cues = await api.getTranscriptCues(video.videoId);
    if (ui.openNote?.videoId !== video.videoId) return;
    if (!cues.length) throw new Error("empty");
    video.cues = cues;
    video._cuesFailed = false;
    const hist = ui.history.find((h) => h.videoId === video.videoId);
    if (hist) hist.cues = cues;
    persistVideo(video).catch(() => {});
  } catch {
    if (ui.openNote?.videoId !== video.videoId) return;
    video._cuesFailed = true;
    if (!quiet) toast("Could not load timestamps. Is the helper running?");
  } finally {
    video._cuesLoading = false;
    if (ui.openNote?.videoId === video.videoId) paintDoc();
  }
}

export function tsToSeconds(t) {
  const parts = String(t || "").split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p)) || parts.length < 2) return -1;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

export function assetStripHtml(video) {
  // Compact index only — the reconstruction lives in the note markdown (## On screen appendix)
  const assets = Array.isArray(video.assets) ? video.assets : [];
  if (!assets.length && !video.visualStatus) return "";
  const base = videoWatchUrl(video);
  const items = assets.slice(0, 8).map((a) => {
    const secs = tsToSeconds(a.t);
    const link = secs >= 0 ? `${base}&t=${secs}s` : base;
    const partial = a.completeness === "partial" ? " ·partial" : "";
    return `<a class="asset-item" href="${link}" target="_blank" rel="noreferrer">
      <span class="asset-type">${escapeHtml(a.type)}</span>
      <span class="asset-ts">${escapeHtml(a.t)}${partial}</span>
      <span class="asset-title">${escapeHtml(a.title)}</span>
    </a>`;
  }).join("");
  const statusNote = !assets.length && video.visualStatus
    ? `<div class="asset-empty">${video.visualStatus === "skipped" ? "Visual pass skipped" : video.visualStatus === "failed" ? "Visual pass failed" : "No reconstructable on-screen objects"}${video.visualNote ? ` — ${escapeHtml(video.visualNote)}` : ""}</div>`
    : "";
  if (!items && !statusNote) return "";
  return `<div class="asset-strip">${statusNote}${items}</div>`;
}
