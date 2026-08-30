import * as api from "./api.js";
import { getState } from "./state.js";
import { $, toast } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { formatWhen, thumbUrl } from "./duration.js";
import { escapeHtml } from "./markdown.js";
import { videoTime, videoChannelLabel, categoryHasVisual, needsCategory, hasRealCategory, videoWatchUrl } from "./video-info.js";
import { setTab, writeHash } from "./router.js";
import { openInGemini } from "./gemini-open.js";
import { loadHistory } from "./data.js";
import { renderSettings } from "./settings.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function renderFilters() {
  const cats = [...new Set(ui.queue.map((v) => v.category).filter(Boolean))];
  const chans = [...new Set(ui.queue.map((v) => videoChannelLabel(v)).filter(Boolean))];
  const catBox = $("cat-filters");
  const chanBox = $("chan-filters");
  const toggle = $("toggle-channels");
  catBox.innerHTML = "";
  chanBox.innerHTML = "";

  const add = (box, label, type, value, kind) => {
    const b = document.createElement("button");
    b.type = "button";
    const on = ui.filter.type === type && ui.filter.value === value;
    b.className = `chip ${kind}` + (on ? " on" : "");
    b.textContent = label;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.onclick = () => { ui.filter = { type, value }; renderPending(); writeHash("pending"); };
    box.appendChild(b);
  };

  add(catBox, "All", "all", "", "cat");
  cats.forEach((c) => add(catBox, c, "category", c, "cat"));
  chans.forEach((c) => add(chanBox, c, "channel", c, "chan"));

  toggle.classList.toggle("open", ui.showChannelFilters);
  toggle.setAttribute("aria-expanded", ui.showChannelFilters ? "true" : "false");
  chanBox.classList.toggle("hidden", !ui.showChannelFilters);
  if (ui.filter.type === "channel") {
    ui.showChannelFilters = true;
    toggle.classList.add("open");
    chanBox.classList.remove("hidden");
  }
}

export function categoryNames(current) {
  const names = ui.categories.map((c) => c.name).filter(Boolean);
  if (current && !names.includes(current)) names.unshift(current);
  return names;
}

export function categorySelectHtml(video) {
  const current = String(video.category || "").trim();
  const names = categoryNames(current);
  const placeholder = !hasRealCategory(video);
  const opts = [
    placeholder ? `<option value="">Choose Category</option>` : "",
    ...names.map((n) => `<option value="${n}" ${!placeholder && n === current ? "selected" : ""}>${n}</option>`),
  ].join("");
  return `<select class="card-cat" data-cat aria-label="Category">${opts}</select>`;
}

export function needsCategoryVideos() {
  return ui.queue.filter((v) => needsCategory(v));
}

export function visibleQueue() {
  const now = Date.now();
  let list = [...ui.queue].filter((v) => !needsCategory(v)).sort((a, b) => videoTime(b) - videoTime(a));
  if (ui.filter.type === "category") list = list.filter((v) => v.category === ui.filter.value);
  if (ui.filter.type === "channel") {
    list = list.filter((v) => videoChannelLabel(v) === ui.filter.value);
  }
  const recent = list.filter((v) => now - videoTime(v) <= WEEK_MS);
  const older = list.filter((v) => now - videoTime(v) > WEEK_MS);
  return { recent, older };
}

export function renderNeedsCategory() {
  const needs = needsCategoryVideos();
  const box = $("needs-cat");
  const list = $("needs-cat-list");
  box.classList.toggle("hidden", needs.length === 0);
  if (!needs.length) {
    list.innerHTML = "";
    return;
  }
  $("needs-cat-label").textContent = `Needs a Category · ${needs.length} video${needs.length === 1 ? "" : "s"}`;
  const sel = $("needs-cat-select");
  const names = ui.categories.map((c) => c.name).filter(Boolean);
  sel.innerHTML = `<option value="">Choose Category</option>` + names.map((n) => `<option value="${n}">${n}</option>`).join("");
  list.innerHTML = "";
  needs.forEach((video) => list.appendChild(pendingCard(video)));
}

export function renderPending() {
  const { recent, older } = visibleQueue();
  const shown = ui.showOlder ? [...recent, ...older] : recent;
  const needs = needsCategoryVideos();
  $("pending-count").textContent = String(ui.queue.length);
  $("show-older").classList.toggle("hidden", older.length === 0 || ui.showOlder);
  $("show-older").textContent = `Show ${older.length} Older`;

  const state = ui._lastOpened || 0;
  const newer = ui.queue.filter((v) => videoTime(v) > state).length;
  $("inbox-meta").textContent = newer
    ? `${newer} new since you last opened`
    : `${recent.length} from this week`;

  renderFilters();
  renderNeedsCategory();
  const list = $("pending-list");
  list.innerHTML = "";
  if (!shown.length && !needs.length) {
    const empty = !ui.queue.length && ui.helperOn && !ui.llmReady
      ? "Add your OpenRouter key in Settings to process videos."
      : (ui.queue.length ? "Nothing matches this filter." : "Queue is empty.");
    list.innerHTML = `<div class="empty">${empty}</div>`;
    renderBulk();
    return;
  }
  shown.forEach((video) => list.appendChild(pendingCard(video)));
  renderBulk();
}

export function pendingCard(video) {
  const el = document.createElement("article");
  const job = ui.jobs.get(video.videoId);
  const noLlm = ui.helperOn && !ui.llmReady;
  const canProcess = ui.helperOn && ui.llmReady && hasRealCategory(video) && !needsCategory(video);
  const title = video.title || video.videoId;
  const url = video.videoUrl || `https://www.youtube.com/watch?v=${video.videoId}`;
  el.className = "card" + (job ? ` ${job}` : "");
  el.innerHTML = `
    <input type="checkbox" data-id="${escapeHtml(video.videoId)}" aria-label="Select ${escapeHtml(title)}" ${ui.selected.has(video.videoId) ? "checked" : ""} />
    <img class="thumb" alt="${escapeHtml(title)}" width="88" height="50" loading="lazy" src="${thumbUrl(video.videoId)}" />
    <div>
      <a class="title" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
      <div class="meta">${escapeHtml(videoChannelLabel(video) || "Channel unknown")} · ${escapeHtml(video.duration || "?")} · ${escapeHtml(formatWhen(video.publishedAt || video.addedAt))}</div>
      <div class="meta">${categorySelectHtml(video)} ${categoryHasVisual(video) ? `<span class="chip visual-chip">visual</span>` : ""} <button type="button" class="change" data-copy-desc="${escapeHtml(video.videoId)}">Copy Description</button></div>
      <div class="row-actions">
        <button type="button" class="btn process" data-gemini="${escapeHtml(video.videoId)}">Gemini</button>
        <button type="button" class="change" data-process="${escapeHtml(video.videoId)}" ${canProcess ? "" : "disabled"} title="${noLlm ? "Add your OpenRouter key in Settings" : canProcess ? "Process with the helper (transcript + LLM)" : "Choose a category first"}">API Process</button>
        <button type="button" class="btn discard" data-discard="${escapeHtml(video.videoId)}">Discard</button>
        ${job ? `<span class="meta">${escapeHtml(job)}</span>` : ""}
      </div>
    </div>
  `;
  el.querySelector("input").onchange = (e) => {
    if (e.target.checked) ui.selected.add(video.videoId);
    else ui.selected.delete(video.videoId);
    renderBulk();
  };
  el.querySelector("[data-process]").onclick = () => processOne(video);
  el.querySelector("[data-discard]").onclick = () => discardOne(video);
  el.querySelector("[data-cat]").onchange = (e) => onCategoryChange(video, e.target.value);
  el.querySelector("[data-gemini]").onclick = () => openInGemini(video, true);
  el.querySelector("[data-copy-desc]").onclick = () => copyPendingDescription(video);
  return el;
}

export async function copyPendingDescription(video) {
  if (!(await api.helperUp())) {
    toast("Start the helper to copy the description.");
    return;
  }
  try {
    if (!video._fullDescription) {
      const data = await api.getDescription(video.videoId, video.channelId);
      const text = String(data.description || "").trim();
      if (!text) {
        toast("No description");
        return;
      }
      video._fullDescription = text;
    }
    await navigator.clipboard.writeText(video._fullDescription);
    toast("Copied description");
  } catch (err) {
    toast(String(err.message || err).includes("404") ? "No description" : "Could not copy description");
  }
}

export function shownVideos() {
  const { recent, older } = visibleQueue();
  const rest = ui.showOlder ? [...recent, ...older] : recent;
  return [...needsCategoryVideos(), ...rest];
}

export function renderBulk() {
  const bar = $("bulk-bar");
  const n = ui.selected.size;
  const shown = shownVideos();
  const allOn = shown.length > 0 && shown.every((v) => ui.selected.has(v.videoId));
  bar.classList.toggle("hidden", n === 0);
  $("bulk-label").textContent = `${n} selected`;
  $("bulk-gemini").classList.toggle("hidden", n !== 1);
  const btn = $("select-all");
  if (btn) btn.textContent = allOn ? "Deselect All" : "Select All";
}

export function toggleSelectAll() {
  const shown = shownVideos();
  const allOn = shown.length > 0 && shown.every((v) => ui.selected.has(v.videoId));
  if (allOn) shown.forEach((v) => ui.selected.delete(v.videoId));
  else shown.forEach((v) => ui.selected.add(v.videoId));
  renderPending();
}

export async function discardOne(video) {
  ui.queue = ui.queue.filter((v) => v.videoId !== video.videoId);
  ui.selected.delete(video.videoId);
  renderPending();
  await api.discardVideos([video.videoId]);
  toast("Discarded", "Undo", async () => {
    await api.restoreVideo(video);
    ui.queue.push(video);
    renderPending();
  });
}

export async function processOne(video) {
  if (!ui.helperOn) {
    toast("Start the helper to process.");
    return;
  }
  if (!ui.llmReady) {
    toast("Add your OpenRouter key in Settings.");
    setTab("settings");
    await renderSettings();
    return;
  }
  if (needsCategory(video) || !hasRealCategory(video)) {
    toast("Choose a category first.");
    return;
  }
  const state = await getState();
  ui.jobs.set(video.videoId, "working");
  renderPending();
  try {
    const started = await api.processVideos([video], !!state.uiSendTelegram);
    if (started.jobId) await watchJob(started.jobId, [video]);
    else markJob([video], "done");
  } catch (err) {
    markJob([video], "failed");
    toast(String(err.message || err));
  }
}

export async function watchJob(jobId, videos) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const job = await api.jobStatus(jobId);
      if (job.status === "done" || job.status === "failed") {
        const byId = new Map((job.results || []).map((r) => [r.videoId, r]));
        videos.forEach((v) => {
          const r = byId.get(v.videoId);
          ui.jobs.set(v.videoId, r?.status === "error" || job.status === "failed" ? "failed" : "done");
          if (r?.status !== "error" && job.status === "done") {
            ui.queue = ui.queue.filter((q) => q.videoId !== v.videoId);
          }
        });
        renderPending();
        loadHistory();
        return;
      }
    } catch { /* still working */ }
  }
}

export function markJob(videos, status) {
  videos.forEach((v) => ui.jobs.set(v.videoId, status));
  if (status === "done") {
    const ids = new Set(videos.map((v) => v.videoId));
    ui.queue = ui.queue.filter((v) => !ids.has(v.videoId));
  }
  renderPending();
}

export async function onCategoryChange(video, category) {
  if (!category) return;
  await api.updatePendingCategory(video.videoId, category);
  const row = ui.queue.find((v) => v.videoId === video.videoId);
  if (row) {
    row.category = category;
    row.needsCategory = false;
  }
  renderPending();
}

export async function applyNeedsCategory() {
  const category = $("needs-cat-select").value;
  if (!category) {
    toast("Pick a category");
    return;
  }
  const vids = needsCategoryVideos();
  if (!vids.length) return;
  await api.updatePendingCategories(vids.map((v) => v.videoId), category);
  vids.forEach((v) => {
    v.category = category;
    v.needsCategory = false;
  });
  renderPending();
}
