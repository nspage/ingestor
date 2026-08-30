import * as api from "./api.js";
import { $, toast, sleep } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { formatWhen, thumbUrl } from "./duration.js";
import { escapeHtml, hasTranscript, transcriptCues, transcriptCopyText } from "./markdown.js";
import { isSynthNote, isBranchNote, isYoutubeNote, isTrackedVideo, videoChannelLabel, videoWatchUrl, branchParentId, branchRootId } from "./video-info.js";
import { openDoc, noteCopyText } from "./notes.js";
import { openInGemini } from "./gemini-open.js";
import { setTab, writeHash } from "./router.js";
import { processOne } from "./pending.js";

export function historyRows() {
  const q = ($("history-search").value || "").toLowerCase();
  const { category, source, desc } = ui.historyFilter;
  return ui.history.filter((v) => {
    if (isBranchNote(v) && !q) return false;

    const blob = `${v.title || ""} ${videoChannelLabel(v)}`.toLowerCase();
    if (q && !blob.includes(q)) return false;
    if (category && v.category !== category) return false;
    if (source === "gemini-web" && v.analysisSource !== "gemini-web") return false;
    if (source === "api" && v.analysisSource === "gemini-web") return false;
    if (desc === "added" && v.descriptionStatus !== "added") return false;
    return true;
  });
}

export function renderHistoryFilters() {
  const cats = [...new Set(ui.history.map((v) => v.category).filter(Boolean))];
  $("history-cat-block").classList.toggle("hidden", cats.length === 0);
  const add = (box, label, key, value) => {
    const b = document.createElement("button");
    b.type = "button";
    const on = ui.historyFilter[key] === value;
    b.className = "chip cat" + (on ? " on" : "");
    b.textContent = label;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.onclick = () => {
      ui.historyFilter[key] = value;
      renderHistory();
      writeHash("history");
    };
    box.appendChild(b);
  };
  const catBox = $("history-cat-filters");
  catBox.innerHTML = "";
  add(catBox, "All", "category", "");
  cats.forEach((c) => add(catBox, c, "category", c));
  const srcBox = $("history-source-filters");
  srcBox.innerHTML = "";
  add(srcBox, "All", "source", "");
  add(srcBox, "Gemini", "source", "gemini-web");
  add(srcBox, "API", "source", "api");
  const descBox = $("history-desc-filters");
  descBox.innerHTML = "";
  add(descBox, "All", "desc", "");
  add(descBox, "Has Description", "desc", "added");
}

export function renderHistoryBulk() {
  const n = selectedHistory().length;
  $("history-bulk").classList.toggle("hidden", n === 0);
  $("history-bulk-label").textContent = `${n} selected`;
  const rows = historyRows();
  const allOn = rows.length > 0 && rows.every((v) => ui.historySelected.has(v.videoId));
  $("history-select-all").textContent = allOn ? "Deselect All" : "Select All";
  renderHistoryExport();
}

export function exportTargets() {
  const selected = selectedHistory();
  return selected.length ? selected : historyRows();
}

export function renderHistoryExport() {
  const n = selectedHistory().length;
  const notesBtn = $("history-export-notes");
  const trBtn = $("history-export-transcripts");
  if (notesBtn) notesBtn.textContent = n > 0 ? `Export ${n} note${n === 1 ? "" : "s"}` : "Export notes";
  if (trBtn) trBtn.textContent = n > 0 ? `Export ${n} transcript${n === 1 ? "" : "s"}` : "Export transcripts";
}

export function toggleHistorySelectAll() {
  const rows = historyRows();
  const allOn = rows.length > 0 && rows.every((v) => ui.historySelected.has(v.videoId));
  if (allOn) rows.forEach((v) => ui.historySelected.delete(v.videoId));
  else rows.forEach((v) => ui.historySelected.add(v.videoId));
  renderHistory();
}

export function selectedHistory() {
  const visible = new Set(historyRows().map((v) => v.videoId));
  return ui.history.filter((v) => ui.historySelected.has(v.videoId) && visible.has(v.videoId));
}

export function exportDateStamp(iso) {
  const parsed = iso ? new Date(iso) : new Date();
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

export function exportTitle(video) {
  const raw = String(video?.title || video?.videoId || "note")
    .replace(/[\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (raw || "note").slice(0, 80);
}

export function exportFilename(video, kind = "note") {
  const suffix = kind === "transcript" ? "-transcript" : "";
  return `ingestor-${exportDateStamp(video?.processedAt)}-${exportTitle(video)}${suffix}.md`;
}

export function noteMarkdownFile(video) {
  return `# ${video.title || video.videoId}\n\n${noteCopyText(video)}`.trim();
}

export function transcriptMarkdownFile(video) {
  const timed = transcriptCues(video).length > 0;
  return `# ${video.title || video.videoId}\n\n${transcriptCopyText(video, timed)}`.trim();
}

export async function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const revoke = () => setTimeout(() => URL.revokeObjectURL(url), 20000);
  try {
    if (chrome?.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      revoke();
      return;
    }
  } catch {
    /* fall through to anchor download */
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  revoke();
}

export async function downloadNotes(vids, kind = "note") {
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i];
    const text = kind === "transcript" ? transcriptMarkdownFile(v) : noteMarkdownFile(v);
    await downloadText(exportFilename(v, kind), text);
    if (i < vids.length - 1) await sleep(80);
  }
}

export async function saveHistoryMarkdown() {
  const vids = exportTargets();
  if (!vids.length) {
    toast("Nothing to export");
    return;
  }
  await downloadNotes(vids, "note");
  toast(`Saved ${vids.length} note${vids.length === 1 ? "" : "s"}`);
}

export async function saveHistoryTranscripts() {
  const vids = exportTargets().filter((v) => hasTranscript(v) || transcriptCues(v).length);
  if (!vids.length) {
    toast("No transcripts to export");
    return;
  }
  await downloadNotes(vids, "transcript");
  toast(`Saved ${vids.length} transcript${vids.length === 1 ? "" : "s"}`);
}

export function notesRemovedWith(vids) {
  const extra = [];
  for (const v of vids) {
    if (isBranchNote(v)) continue;
    extra.push(...ui.history.filter((h) => isBranchNote(h) && branchRootId(h) === v.videoId));
  }
  const seen = new Set();
  const out = [];
  for (const n of [...vids, ...extra]) {
    if (!n?.videoId || seen.has(n.videoId)) continue;
    seen.add(n.videoId);
    out.push(n);
  }
  return out;
}

export async function deleteHistoryItems(vids) {
  if (!vids.length) return;
  const removed = notesRemovedWith(vids);
  const ids = new Set(removed.map((v) => v.videoId));
  ui.history = ui.history.filter((h) => !ids.has(h.videoId));
  ids.forEach((id) => ui.historySelected.delete(id));
  if (ui.openNote && ids.has(ui.openNote.videoId)) setTab("history");
  renderHistory();
  await Promise.all(removed.map((v) => api.unprocessVideo(v.videoId, v.processedAt)));
  const n = removed.length;
  toast(`Deleted ${n} note${n === 1 ? "" : "s"}`, "Undo", async () => {
    for (const v of removed) await api.saveProcessed(v);
    const have = new Set(ui.history.map((h) => h.videoId));
    ui.history = [...removed.filter((v) => !have.has(v.videoId)), ...ui.history];
    renderHistory();
  });
}

export function openHistoryVideos() {
  const vids = selectedHistory().filter((v) => isYoutubeNote(v));
  if (!vids.length) {
    toast("No videos in selection");
    return;
  }
  const urls = vids.map((v) => v.videoUrl || `https://www.youtube.com/watch?v=${v.videoId}`);
  urls.slice(0, 10).forEach((url) => window.open(url, "_blank"));
  if (urls.length > 10) toast(`Opened 10 of ${urls.length}`);
}

export function renderHistory() {
  const failedBox = $("failed-list");
  failedBox.innerHTML = "";
  ui.failed.forEach((item) => {
    const el = document.createElement("article");
    el.className = "card failed";
    el.style.gridTemplateColumns = "1fr";
    el.innerHTML = `
      <div>
        <div class="title">${escapeHtml(item.title || item.videoId)}</div>
        <div class="meta">Failed · ${escapeHtml(item.error || "Unknown error")}</div>
        <div class="row-actions">
          <button type="button" class="btn process" data-retry="${escapeHtml(item.videoId)}" ${ui.helperOn ? "" : "disabled"}>Retry</button>
        </div>
      </div>`;
    el.querySelector("[data-retry]").onclick = async () => {
      await api.clearFailed(item.videoId);
      await processOne(item);
      ui.failed = ui.failed.filter((f) => f.videoId !== item.videoId);
      renderHistory();
    };
    failedBox.appendChild(el);
  });

  renderHistoryFilters();
  const list = $("history-list");
  
  const branchCounts = {};
  ui.history.forEach((v) => {
    if (!isBranchNote(v)) return;
    const pid = branchParentId(v);
    if (pid) branchCounts[pid] = (branchCounts[pid] || 0) + 1;
  });

  const rows = historyRows();
  const visible = new Set(rows.map((v) => v.videoId));
  [...ui.historySelected].forEach((id) => { if (!visible.has(id) && !ui.history.some((v) => v.videoId === id)) ui.historySelected.delete(id); });
  $("history-count").textContent = String(rows.length);
  list.innerHTML = "";
  rows.forEach((v) => {
    const el = document.createElement("article");
    el.className = "card";
    const synth = isSynthNote(v);
    const branch = isBranchNote(v);
    const nSources = Array.isArray(v.sourceVideoIds) ? v.sourceVideoIds.length : 0;
    const branches = branchCounts[v.videoId] || 0;
    const thumbId = branch ? (branchParentId(v) || v.videoId) : v.videoId;
    const title = v.title || v.videoId;
    const watch = v.videoUrl || `https://www.youtube.com/watch?v=${v.videoId}`;
    const thumbHtml = synth
      ? `<div class="thumb synth-thumb" aria-hidden="true"></div>`
      : `<img class="thumb" alt="${escapeHtml(title)}" width="88" height="50" loading="lazy" src="${thumbUrl(thumbId)}" />`;
    const prefix = synth
      ? `Synthesis${nSources ? ` · ${nSources} notes` : ""}`
      : branch ? "Branch" : (videoChannelLabel(v) || "Channel unknown");
    const metaStr = `${prefix} · ${formatWhen(v.processedAt)}${v.analysisSource === "gemini-web" ? " · Gemini" : ""}${branches > 0 ? ` · ${branches} branch${branches > 1 ? "es" : ""}` : ""}`;
    const showTrack = !synth && !branch && !isTrackedVideo(v);
    const openVideo = synth || branch
      ? ""
      : `<a class="text-btn" href="${escapeHtml(watch)}" target="_blank" rel="noreferrer">Open Video</a>`;

    el.innerHTML = `
      <input type="checkbox" data-hid="${escapeHtml(v.videoId)}" aria-label="Select ${escapeHtml(title)}" ${ui.historySelected.has(v.videoId) ? "checked" : ""} />
      ${thumbHtml}
      <div>
        <button type="button" class="title" data-note>${escapeHtml(title)}</button>
        <div class="meta">${escapeHtml(metaStr)}${showTrack ? ` <span class="track-row"><select data-track-cat aria-label="Category for tracking">${ui.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("")}</select><button type="button" class="text-btn" data-track>Track</button></span>` : ""}</div>
        <div class="row-actions">
          <button type="button" class="text-btn" data-note2>Open Note</button>
          <button type="button" class="text-btn" data-transcript ${hasTranscript(v) || isYoutubeNote(v) ? "" : "disabled"}>Open Transcript</button>
          ${openVideo}
          <button type="button" class="text-btn" data-gemini>Gemini</button>
          <button type="button" class="text-btn" data-del>Delete</button>
        </div>
      </div>`;
    el.querySelector("input").onchange = (e) => {
      if (e.target.checked) ui.historySelected.add(v.videoId);
      else ui.historySelected.delete(v.videoId);
      renderHistoryBulk();
    };
    el.querySelector("[data-note]").onclick = () => openDoc(v, "note");
    el.querySelector("[data-note2]").onclick = () => openDoc(v, "note");
    el.querySelector("[data-transcript]").onclick = () => openDoc(v, "transcript");
    el.querySelector("[data-gemini]").onclick = () => openInGemini(v, false);
    el.querySelector("[data-del]").onclick = (e) => {
      e.stopPropagation();
      deleteHistoryItems([v]);
    };
    const trackBtn = el.querySelector("[data-track]");
    if (trackBtn) {
      trackBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!ui.helperOn) { toast("Start the helper to track a channel."); return; }
        const cat = el.querySelector("[data-track-cat]")?.value || ui.categories[0]?.name || "";
        const url = v.channelId && v.channelId !== "manual_ingest"
          ? `https://www.youtube.com/channel/${v.channelId}`
          : (v.videoUrl || `https://www.youtube.com/watch?v=${v.videoId}`);
        const res = await api.addChannel(url, cat);
        if (!res.success) { toast(res.error || "Could not track"); return; }
        toast(`Tracking ${res.channel?.name || v.channelName || "channel"}`);
        ui.channels = await api.getChannels().catch(() => ui.channels);
        renderHistory();
      };
    }
    list.appendChild(el);
  });
  renderHistoryBulk();
}
