import * as api from "./app/api.js";
import { getState, setState, keys } from "./app/state.js";
import { formatWhen, thumbUrl } from "./app/duration.js";
import { decodeHtmlEntities, isPlaceholderChannelName } from "./app/inbox-rules.js";
import { renderMarkdown, renderDescription, enrichDescription, renderTranscript, hasTranscript, transcriptCues, transcriptCopyText, isGeminiNote, splitAnalysisTurns, joinAnalysisTurns, gfmToTsv, escapeHtml } from "./app/markdown.js";

const MODELS = [
  { id: "google/gemini-3.1-flash-lite", name: "3.1 Flash Lite" },
  { id: "google/gemini-3-flash-preview", name: "3 Flash" },
  { id: "google/gemini-3.1-pro-preview", name: "3.1 Pro" },
  { id: "google/gemini-3.6-flash", name: "3.6 Flash" },
  { id: "google/gemini-3.7-flash", name: "3.7 Flash" },
  { id: "google/gemini-2.5-flash-lite", name: "2.5 Flash Lite" },
  { id: "google/gemini-2.5-flash", name: "2.5 Flash" },
  { id: "google/gemini-2.5-pro", name: "2.5 Pro" },
];

const VISUAL_KINDS = ["slide", "diagram", "ui", "code", "chart", "product", "on_screen_text"];
const VISUAL_MODELS = ["google/gemini-3.7-flash", "google/gemini-3.6-flash"];

/** KV may still hold bare Gemini ids from before OpenRouter. */
function normalizeModelId(id) {
  const raw = String(id || "").trim();
  if (!raw) return "google/gemini-3.1-flash-lite";
  if (raw === "gemini-3-flash" || raw === "google/gemini-3-flash") return "google/gemini-3-flash-preview";
  if (raw === "gemini-3-pro" || raw === "google/gemini-3-pro") return "google/gemini-3.1-pro-preview";
  if (raw.includes("/")) return raw;
  return "google/" + raw;
}

const DEFAULT_CAT_PROMPT = `You are an expert Content Strategist. Based on the following transcript snippets, classify this channel into EXACTLY one of the following six categories.

CATEGORIES:
1. Tactical: Practical how-to guides, technical tutorials, walkthroughs, coding, or step-by-step SOPs.
2. Ideation: Brainstorming business ideas, market white space, niche hunting, or consumer trends.
3. Strategy: High-level frameworks, mental models, macro shifts, or long-term positioning.
4. News/Roundup: Current events, industry headlines, weekly updates, or commentary on trends.
5. second brain: PKM, productivity systems, note-taking, or linking-your-thinking workflows.
6. short text extract: Shorts and clips where the value is on-screen text (prompts, emails, tweets, notes the OP scrolls through).

Instructions:
- Return ONLY the category name (one of: Tactical, Ideation, Strategy, News/Roundup, second brain, short text extract).
- If it fits multiple, pick the most dominant one.`;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ui = {
  queue: [],
  channels: [],
  categories: [],
  history: [],
  failed: [],
  helperOn: false,
  llmReady: false,
  selected: new Set(),
  historySelected: new Set(),
  filter: { type: "all", value: "" },
  showOlder: false,
  showChannelFilters: false,
  jobs: new Map(),
  openNote: null,
  docMode: "note",
  showTimestamps: true,
  descEdit: true,
  descReedit: false,
  descOpen: true,
  composerTall: false,
  composerDrafts: {},
  composerVideoId: "",
  prefillOpen: false,
  noteJustOpened: false,
  historyFilter: { category: "", source: "", desc: "" },
  branchMode: false,
  branchPrompts: [""],
};

function $(id) { return document.getElementById(id); }

function reduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scrollBehavior() {
  return reduceMotion() ? "auto" : "smooth";
}

function toast(message, actionLabel, onAction) {
  const el = $("toast");
  el.replaceChildren();
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "text-btn";
    btn.textContent = actionLabel;
    btn.onclick = () => { onAction(); el.classList.add("hidden"); };
    el.appendChild(btn);
  }
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 10000);
}

function parseHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  const qIndex = raw.indexOf("?");
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const qs = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : "");
  const parts = path.split("/").filter(Boolean);
  return { parts, qs };
}

function writeHash(name) {
  let path = name;
  const q = new URLSearchParams();
  if (name === "pending") {
    if (ui.filter.type && ui.filter.type !== "all") {
      q.set("type", ui.filter.type);
      q.set("value", ui.filter.value || "");
    }
  } else if (name === "history") {
    const search = $("history-search")?.value || "";
    if (search) q.set("q", search);
    if (ui.historyFilter.category) q.set("category", ui.historyFilter.category);
    if (ui.historyFilter.source) q.set("source", ui.historyFilter.source);
    if (ui.historyFilter.desc) q.set("desc", ui.historyFilter.desc);
  } else if (name === "note" && ui.openNote?.videoId) {
    path = `note/${encodeURIComponent(ui.openNote.videoId)}`;
    if (ui.docMode === "transcript") path += "/transcript";
  }
  const qs = q.toString();
  const hash = `#${qs ? `${path}?${qs}` : path}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function setTab(name, opts = {}) {
  if (name !== "note") stashComposer();
  ui.openNote = name === "note" ? ui.openNote : null;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".view").forEach((v) => {
    const on = v.id === `view-${name}`;
    v.classList.toggle("active", on);
    v.toggleAttribute("hidden", !on);
  });
  if (name !== "settings" && name !== "note") setState({ [keys().lastTab]: name });
  if (!opts.fromHash) writeHash(name);
}

function applyHash() {
  const { parts, qs } = parseHash();
  const root = parts[0] || "";
  if (!root) return false;
  if (root === "note") {
    const id = decodeURIComponent(parts[1] || "");
    const mode = parts[2] === "transcript" ? "transcript" : "note";
    const video = ui.history.find((h) => h.videoId === id);
    if (video) openDoc(video, mode, { fromHash: true });
    else setTab("history", { fromHash: true });
    return true;
  }
  if (root === "pending") {
    ui.filter = { type: qs.get("type") || "all", value: qs.get("value") || "" };
    setTab("pending", { fromHash: true });
    renderPending();
    return true;
  }
  if (root === "history") {
    ui.historyFilter = {
      category: qs.get("category") || "",
      source: qs.get("source") || "",
      desc: qs.get("desc") || "",
    };
    if ($("history-search")) $("history-search").value = qs.get("q") || "";
    setTab("history", { fromHash: true });
    renderHistory();
    return true;
  }
  if (root === "channels" || root === "settings") {
    setTab(root, { fromHash: true });
    if (root === "settings") renderSettings();
    return true;
  }
  return false;
}

function openDoc(video, mode, opts = {}) {
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

function paintDoc() {
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

function noteCopyText(video) {
  const body = isGeminiNote(video)
    ? joinAnalysisTurns(splitAnalysisTurns(video.analysis, video.analysisTurns))
    : (video.analysis || "");
  const parts = [body];
  const added = addedDescription(video);
  if (added) parts.push(`## Description\n\n${added}`);
  return parts.filter((p) => p !== "").join("\n\n");
}

function addedDescription(video) {
  if (video?.descriptionStatus !== "added") return "";
  return String(video.description || video.descriptionBlock || "").trim();
}

function geminiTurns(video) {
  return splitAnalysisTurns(video?.analysis, video?.analysisTurns);
}

function stashComposer() {
  const box = $("composer-input");
  if (!box || !ui.composerVideoId) return;
  ui.composerDrafts[ui.composerVideoId] = box.value;
}

function loadComposer(videoId) {
  const box = $("composer-input");
  if (!box) return;
  if (ui.composerVideoId === videoId) return;
  stashComposer();
  ui.composerVideoId = videoId || "";
  box.value = (videoId && ui.composerDrafts[videoId]) || "";
}

let copyDrag = null;
let copyAnchor = null;

function copyUnitText(el) {
  const encoded = el.getAttribute("data-copy");
  return encoded ? decodeURIComponent(encoded) : (el.innerText || "").trim();
}

function copyUnitsInScroll() {
  return [...($("note-scroll")?.querySelectorAll(".copy-unit") || [])];
}

function clearCopyRange() {
  copyUnitsInScroll().forEach((el) => el.classList.remove("on"));
  $("note-scroll")?.classList.remove("copy-dragging");
}

function paintCopyRange(from, to) {
  const units = copyUnitsInScroll();
  const a = units.indexOf(from);
  const b = units.indexOf(to);
  if (a < 0 || b < 0) return [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const slice = units.slice(lo, hi + 1);
  units.forEach((el) => el.classList.toggle("on", slice.includes(el)));
  return slice;
}

function joinCopyUnits(els) {
  let out = "";
  for (let i = 0; i < els.length; i += 1) {
    const text = copyUnitText(els[i]);
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    const sameLine = els[i].parentElement
      && els[i].parentElement === els[i - 1].parentElement
      && /^(P|LI|H1|H2|H3|H4)$/.test(els[i].parentElement.tagName)
      && !els[i].classList.contains("cue");
    const cue = els[i].classList.contains("cue") || els[i - 1].classList.contains("cue");
    out += sameLine ? " " : cue ? "\n" : "\n\n";
    out += text;
  }
  return out;
}

function unitFromPoint(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const unit = el?.closest?.(".copy-unit");
  if (!unit || !$("note-scroll")?.contains(unit)) return null;
  return unit;
}

async function copyText(text, count, message) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(message || (count > 1 ? `Copied ${count}` : "Copied"));
  } catch {
    toast("Could not copy");
  }
}

function composerVisible() {
  return !!$("note-composer") && !$("note-composer").classList.contains("hidden");
}

function enterBranchMode() {
  if (!ui.openNote?.geminiChatUrl) return;
  stashComposer();
  ui.branchMode = true;
  if (!ui.branchPrompts.length) ui.branchPrompts = [""];
  $("composer-followup").classList.add("hidden");
  $("composer-branch").classList.remove("hidden");
  $("note-composer").classList.add("branch-mode");
  paintBranchList();
}

function exitBranchMode() {
  ui.branchMode = false;
  $("composer-branch").classList.add("hidden");
  $("composer-followup").classList.remove("hidden");
  $("note-composer").classList.remove("branch-mode");
  $("branch-progress").classList.add("hidden");
}

function paintBranchList() {
  const list = $("branch-list");
  list.innerHTML = "";
  $("branch-count").textContent = String(ui.branchPrompts.length);
  $("branch-add").disabled = ui.branchPrompts.length >= 3;

  ui.branchPrompts.forEach((prompt, i) => {
    const row = document.createElement("div");
    row.className = "branch-row";
    const idx = document.createElement("span");
    idx.className = "branch-idx";
    idx.textContent = String(i + 1);
    const area = document.createElement("textarea");
    area.rows = 2;
    area.placeholder = "Option-click note content to insert here…";
    area.value = prompt;
    area.oninput = (e) => { ui.branchPrompts[i] = e.target.value; };
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "text-btn";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove Branch");
    rm.onclick = () => {
      ui.branchPrompts.splice(i, 1);
      if (!ui.branchPrompts.length) ui.branchPrompts = [""];
      paintBranchList();
    };
    row.append(idx, area, rm);
    list.appendChild(row);
  });
}

function addBranchRow() {
  if (ui.branchPrompts.length >= 3) return;
  ui.branchPrompts.push("");
  paintBranchList();
  const areas = $("branch-list").querySelectorAll("textarea");
  areas[areas.length - 1]?.focus();
}

async function sendBranches() {
  const prompts = ui.branchPrompts.filter((p) => p.trim());
  if (!prompts.length) { toast("Write at least one branch prompt."); return; }

  const video = ui.openNote;
  const chatUrl = video?.geminiChatUrl || "";
  const convoId = geminiChatId(chatUrl);
  if (!convoId) { toast("No Gemini conversation linked."); return; }

  $("branch-send").disabled = true;
  $("branch-progress").classList.remove("hidden");
  $("branch-progress").textContent = "Starting…";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "GEMINI_BRANCH",
      conversationId: convoId,
      branches: prompts.map((p) => ({ prompt: p })),
      video: {
        videoId: video.videoId,
        title: video.title,
        category: video.category,
        geminiChatUrl: chatUrl,
      },
    });

    if (res?.success) {
      const n = (res.results || []).filter((r) => r.success).length;
      toast(`Branched ${n} conversation(s)`);
      ui.branchPrompts = [""];
      exitBranchMode();
    } else {
      toast(res?.error || "Branch failed");
    }
  } finally {
    $("branch-send").disabled = false;
  }
}

function insertAtComposer(text) {
  if (ui.branchMode) {
    const areas = [...$("branch-list").querySelectorAll("textarea")];
    const focused = areas.find((a) => a === document.activeElement) || areas[areas.length - 1];
    if (!focused) return false;
    const start = focused.selectionStart ?? focused.value.length;
    const end = focused.selectionEnd ?? start;
    focused.value = `${focused.value.slice(0, start)}${text}${focused.value.slice(end)}`;
    const pos = start + text.length;
    focused.focus();
    focused.setSelectionRange(pos, pos);
    const idx = areas.indexOf(focused);
    if (idx >= 0) ui.branchPrompts[idx] = focused.value;
    return true;
  }
  const box = $("composer-input");
  if (!box || !text) return false;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.value = `${box.value.slice(0, start)}${text}${box.value.slice(end)}`;
  const pos = start + text.length;
  box.focus();
  box.setSelectionRange(pos, pos);
  stashComposer();
  return true;
}

function copyUnitFromEvent(e) {
  if (copyDrag) return;
  const tsvBtn = e.target.closest(".table-tsv");
  if (tsvBtn && $("note-scroll")?.contains(tsvBtn)) {
    e.preventDefault();
    const wrap = tsvBtn.closest(".md-table-wrap");
    copyText(gfmToTsv(wrap ? copyUnitText(wrap) : ""), 1, "Copied TSV");
    return;
  }
  if (e.target.closest("button, a, textarea, input, select")) return;
  if (e.metaKey || e.ctrlKey) return;
  const unit = e.target.closest(".copy-unit");
  if (!unit) return;
  e.preventDefault();
  if (e.shiftKey && copyAnchor) {
    const selected = paintCopyRange(copyAnchor, unit);
    copyText(joinCopyUnits(selected), selected.length);
    setTimeout(clearCopyRange, 350);
    return;
  }
  copyAnchor = unit;
  const text = copyUnitText(unit);
  if (e.altKey && composerVisible() && insertAtComposer(text)) {
    navigator.clipboard.writeText(text).catch(() => {});
    toast("Inserted");
    return;
  }
  copyText(text, 1);
}

function onCopyPointerDown(e) {
  if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return;
  if (e.target.closest("button, a, textarea, input, select")) return;
  const unit = e.target.closest(".copy-unit");
  if (!unit) return;
  e.preventDefault();
  copyDrag = { start: unit, last: unit };
  $("note-scroll")?.classList.add("copy-dragging");
  paintCopyRange(unit, unit);
}

function onCopyPointerMove(e) {
  if (!copyDrag) return;
  const unit = unitFromPoint(e);
  if (!unit) return;
  copyDrag.last = unit;
  paintCopyRange(copyDrag.start, unit);
}

function onCopyPointerUp() {
  if (!copyDrag) return;
  const selected = paintCopyRange(copyDrag.start, copyDrag.last || copyDrag.start);
  copyDrag = null;
  copyText(joinCopyUnits(selected), selected.length);
  clearCopyRange();
}

function isPrefillTurn(turns, index) {
  const turn = turns[index];
  if (!turn || turn.role !== "user") return false;
  if (!turns.some((t) => t.role === "model")) return false;
  const firstUser = turns.findIndex((t) => t.role === "user");
  if (index !== firstUser) return false;
  const md = turn.markdown || "";
  if (/^URL:\s*https:\/\/www\.youtube\.com\/watch/m.test(md)) return true;
  if (md.includes("\n---\n") && /VIDEO:/i.test(md)) return true;
  return md.length > 800;
}

function paintTurnNav(video, withTurns) {
  const nav = $("turn-nav");
  nav.innerHTML = "";
  if (addedDescription(video)) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.textContent = "Description";
    jump.classList.toggle("on", ui.descOpen !== false);
    jump.onclick = () => {
      ui.descOpen = ui.descOpen === false;
      paintDoc();
      if (ui.descOpen !== false) $("desc-added")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    };
    nav.appendChild(jump);
  }
  if (!withTurns) return;
  const turns = geminiTurns(video);
  const counts = { user: 0, model: 0 };
  turns.forEach((turn, i) => {
    const n = turn.role === "user" ? (counts.user += 1) : (counts.model += 1);
    const jump = document.createElement("button");
    jump.type = "button";
    jump.textContent = turn.role === "user" ? `You ${n}` : `Gemini ${n}`;
    jump.onclick = () => {
      if (isPrefillTurn(turns, i) && !ui.prefillOpen) {
        ui.prefillOpen = true;
        paintDoc();
      }
      document.getElementById(`turn-${i}`)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    };
    nav.appendChild(jump);
  });
}

function paintGeminiThread(video) {
  const turns = geminiTurns(video);
  const thread = $("note-thread");
  thread.innerHTML = "";
  const counts = { user: 0, model: 0 };
  turns.forEach((turn, i) => {
    const n = turn.role === "user" ? (counts.user += 1) : (counts.model += 1);
    const label = turn.role === "user" ? `You ${n}` : `Gemini ${n}`;
    const prefill = isPrefillTurn(turns, i);
    const collapsed = prefill && !ui.prefillOpen;
    const title = collapsed ? `${label} · prompt` : label;

    const card = document.createElement("article");
    card.className = `turn ${turn.role === "user" ? "you" : "gemini"}${collapsed ? " collapsed" : ""}`;
    card.id = `turn-${i}`;
    const prefillBtn = prefill
      ? `<button type="button" class="change" data-prefill>${ui.prefillOpen ? "Collapse" : "Expand"}</button>`
      : "";
    const editBtn = collapsed ? "" : `<button type="button" class="change" data-edit>Edit</button>`;
    card.innerHTML = `
      <div class="turn-hd"><span>${title}</span><div class="turn-hd-actions">${prefillBtn}${editBtn}</div></div>
      <div class="md turn-body">${collapsed ? "" : renderMarkdown(turn.markdown, video)}</div>
    `;
    card.querySelector("[data-prefill]")?.addEventListener("click", () => {
      ui.prefillOpen = !ui.prefillOpen;
      paintDoc();
    });
    card.querySelector("[data-edit]")?.addEventListener("click", () => editTurn(video, i));
    thread.appendChild(card);
  });
  if (ui.noteJustOpened) {
    ui.noteJustOpened = false;
    const firstModel = turns.findIndex((t) => t.role === "model");
    if (firstModel >= 0) {
      requestAnimationFrame(() => {
        document.getElementById(`turn-${firstModel}`)?.scrollIntoView({ behavior: "auto", block: "start" });
      });
    }
  }
}

function editTurn(video, index) {
  const turns = geminiTurns(video);
  const turn = turns[index];
  const card = document.getElementById(`turn-${index}`);
  if (!card || !turn) return;
  const body = card.querySelector(".turn-body");
  body.innerHTML = `<textarea></textarea><div class="row-actions"><button type="button" class="btn process" data-save>Save</button><button type="button" class="btn discard" data-cancel>Cancel</button></div>`;
  const area = body.querySelector("textarea");
  area.value = turn.markdown;
  area.focus();
  body.querySelector("[data-save]").onclick = async () => {
    turns[index] = { ...turn, markdown: area.value };
    video.analysisTurns = turns;
    video.analysis = joinAnalysisTurns(turns);
    ui.openNote = video;
    await persistVideo(video);
    paintDoc();
    toast("Saved turn");
  };
  body.querySelector("[data-cancel]").onclick = () => paintDoc();
}

async function sendComposer() {
  const box = $("composer-input");
  const prompt = (box?.value || "").trim();
  if (!prompt) {
    toast("Write a follow-up first.");
    return;
  }
  const btn = $("composer-send");
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GEMINI_FOLLOWUP",
      text: prompt,
      videoId: ui.openNote?.videoId,
      geminiChatUrl: ui.openNote?.geminiChatUrl || "",
    });
    if (!res?.success) {
      toast(res?.error === "thread-gone"
        ? "That Gemini chat is gone. Follow-up needs the original thread."
        : "Could not send to Gemini.");
      return;
    }
    box.value = "";
    if (ui.composerVideoId) ui.composerDrafts[ui.composerVideoId] = "";
    toast("Sent. Waiting for Gemini…");
  } finally {
    btn.disabled = false;
  }
}

function rawDescription(video) {
  const block = video.descriptionBlock || "";
  const desc = video.description || "";
  if (block.startsWith("## From the description")) return desc || block;
  return desc || block;
}

function persistVideo(video) {
  const { _cuesLoading, _cuesFailed, _descLoading, _descTried, ...rest } = video;
  const hist = ui.history.find((h) => h.videoId === video.videoId);
  if (hist) Object.assign(hist, rest);
  return api.saveProcessed(rest);
}

function paintDescDraft(video, isNote) {
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

function currentDescBlock() {
  return ui.descEdit ? $("desc-editor").value : (ui.openNote?.descriptionBlock || "");
}

async function loadDescription(video) {
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

async function addDescToNote() {
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

async function dismissDesc() {
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

function isSynthNote(video) {
  return String(video?.videoId || "").startsWith("syn_");
}

function isBranchNote(video) {
  return !!(video?.branchSource) || String(video?.videoId || "").startsWith("brn_");
}

function isYoutubeNote(video) {
  return !!video?.videoId && !isSynthNote(video) && !isBranchNote(video);
}

function geminiChatId(url) {
  try {
    const u = new URL(String(url || ""));
    const m = u.pathname.match(/\/app\/([^/]+)\/?$/);
    return m && m[1] ? m[1] : "";
  } catch {
    return "";
  }
}

function branchParentId(video) {
  return video?.branchSource?.parentVideoId
    || (isBranchNote(video) && video.sourceVideoIds && video.sourceVideoIds[0])
    || "";
}

function branchRootId(video) {
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

function branchFamily(video) {
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

function branchChipLabel(member) {
  if (!isBranchNote(member)) return "Original";
  const parts = String(member.title || "").split(" — ");
  return parts.length > 1 ? parts.pop() : "Branch";
}

function paintBranchNav(video) {
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

async function maybeLoadCues(video, force) {
  if (!isYoutubeNote(video) || transcriptCues(video).length) return;
  if (!(await api.helperUp())) {
    if (force) toast("Start the helper to fetch the transcript.");
    return;
  }
  await loadCues(video, !force);
}

async function loadCues(video, quiet = false) {
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

function videoTime(v) {
  return new Date(v.addedAt || v.publishedAt || 0).getTime();
}

function channelName(id) {
  return ui.channels.find((c) => c.id === id)?.name || "";
}

function videoChannelLabel(video) {
  const stored = decodeHtmlEntities(video?.channelName).trim();
  const fromList = decodeHtmlEntities(channelName(video?.channelId)).trim();
  if (!isPlaceholderChannelName(stored)) return stored;
  if (!isPlaceholderChannelName(fromList)) return fromList;
  return "";
}

function isTrackedVideo(video) {
  const id = String(video?.channelId || "").trim();
  if (!id || id === "manual_ingest") return false;
  return ui.channels.some((c) => c.id === id);
}

function channelCardName(ch) {
  const name = decodeHtmlEntities(ch.name).trim();
  return isPlaceholderChannelName(name) ? (ch.id || name) : name;
}

function lastActivity(channelId) {
  const times = [
    ...ui.queue.filter((v) => v.channelId === channelId).map(videoTime),
    ...ui.history.filter((v) => v.channelId === channelId).map((v) => new Date(v.processedAt || 0).getTime()),
  ].filter(Boolean);
  if (!times.length) return "";
  return formatWhen(new Date(Math.max(...times)).toISOString());
}

async function refreshStatus() {
  const health = await api.helperHealth();
  ui.helperOn = !!health.ok;
  ui.llmReady = !!(health.llm || health.openrouter || health.gemini);
  const pill = $("helper-pill");
  $("helper-label").textContent = ui.helperOn ? "Helper on" : "Helper off";
  pill.classList.toggle("on", ui.helperOn);
  pill.classList.toggle("off", !ui.helperOn);
  pill.disabled = false;
  pill.title = ui.helperOn ? "Helper is running" : "Start Helper";
  pill.setAttribute("aria-label", pill.title);
  $("start-btn").classList.toggle("hidden", ui.helperOn);
  if (ui.helperOn) await api.bootstrap().catch(() => {});
  const cost = await api.getCost().catch(() => ({ cost: 0 }));
  const costText = `$${(cost.cost || 0).toFixed(5)} today`;
  $("status-meta").textContent = ui.helperOn && !ui.llmReady
    ? `${costText} · add OpenRouter key in Settings`
    : costText;
}

async function startHelperFromUi() {
  if (ui.helperOn) return;
  $("helper-label").textContent = "Starting…";
  await api.startHelper();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await api.helperUp()) {
      await api.bootstrap();
      await loadAll();
      return;
    }
  }
  toast("Helper did not come up. Try again.");
  await refreshStatus();
}

function renderFilters() {
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

function needsCategory(video) {
  return !!video?.needsCategory;
}

function hasRealCategory(video) {
  const name = String(video?.category || "").trim();
  return !!name && name !== "uncategorised";
}

function categoryNames(current) {
  const names = ui.categories.map((c) => c.name).filter(Boolean);
  if (current && !names.includes(current)) names.unshift(current);
  return names;
}

function categorySelectHtml(video) {
  const current = String(video.category || "").trim();
  const names = categoryNames(current);
  const placeholder = !hasRealCategory(video);
  const opts = [
    placeholder ? `<option value="">Choose Category</option>` : "",
    ...names.map((n) => `<option value="${n}" ${!placeholder && n === current ? "selected" : ""}>${n}</option>`),
  ].join("");
  return `<select class="card-cat" data-cat aria-label="Category">${opts}</select>`;
}

function needsCategoryVideos() {
  return ui.queue.filter((v) => needsCategory(v));
}

function visibleQueue() {
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

function renderNeedsCategory() {
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

function renderPending() {
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

function pendingCard(video) {
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

function videoWatchUrl(video) {
  return video.videoUrl || `https://www.youtube.com/watch?v=${video.videoId}`;
}

function categoryHasVisual(video) {
  const name = String(video.category || "").trim();
  if (!name) return false;
  const cat = ui.categories.find((c) => c.name === name)
    || ui.categories.find((c) => c.name && c.name.toLowerCase() === name.toLowerCase());
  return !!(cat?.visualAssets?.enabled && cat.visualAssets.kinds?.length);
}

function tsToSeconds(t) {
  const parts = String(t || "").split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p)) || parts.length < 2) return -1;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

function assetStripHtml(video) {
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

function geminiPrefillText(video) {
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

function bindGeminiOpen(session, tabId) {
  const next = { ...session, tabId };
  chrome.storage.local.set({ geminiSession: next });
  chrome.storage.session.get("geminiTabSessions", (data) => {
    const all = data.geminiTabSessions || {};
    all[String(tabId)] = next;
    chrome.storage.session.set({ geminiTabSessions: all });
  });
}

function openInGemini(video, fromPending) {
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

async function copyPendingDescription(video) {
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

async function onGeminiImported(msg) {
  const video = msg.video;
  if (!video?.videoId) return;
  ui.queue = ui.queue.filter((q) => q.videoId !== video.videoId);
  ui.selected.delete(video.videoId);
  const existing = ui.history.find((h) => h.videoId === video.videoId);
  if (existing) {
    const keep = {
      description: existing.description,
      descriptionBlock: existing.descriptionBlock,
      descriptionStatus: existing.descriptionStatus,
      geminiChatUrl: existing.geminiChatUrl,
      branchSource: existing.branchSource,
    };
    Object.assign(existing, video);
    if (keep.descriptionStatus && !video.descriptionStatus) {
      existing.description = keep.description;
      existing.descriptionBlock = keep.descriptionBlock;
      existing.descriptionStatus = keep.descriptionStatus;
    }
    if (keep.geminiChatUrl && !video.geminiChatUrl) existing.geminiChatUrl = keep.geminiChatUrl;
    if (keep.branchSource && !video.branchSource) existing.branchSource = keep.branchSource;
  } else ui.history.unshift(video);
  renderPending();
  renderHistory();
  const note = existing || video;
  const branch = isBranchNote(note) || msg.kind === "branch";
  if (branch) {
    const open = ui.openNote;
    if (open?.videoId === note.videoId) paintDoc();
    else if (open && branchRootId(open) === branchRootId(note)) paintDoc();
  } else {
    openDoc(note, "note");
  }
  if (msg.auto && !branch) {
    const pending = msg.pending || video;
    toast("Saved Gemini note", "Undo", async () => {
      await api.unprocessVideo(video.videoId, video.processedAt);
      ui.history = ui.history.filter((h) => h.videoId !== video.videoId);
      if (!isSynthNote(video) && !isBranchNote(video)) {
        await api.restoreVideo(pending);
        if (!ui.queue.some((q) => q.videoId === pending.videoId)) ui.queue.push(pending);
      }
      renderPending();
      renderHistory();
    });
  } else if (branch) {
    toast(msg.firstSave === false ? "Updated note" : "Saved branch note");
  } else {
    toast(msg.completed || msg.firstSave ? "Saved Gemini note" : "Updated note");
  }
}

function shownVideos() {
  const { recent, older } = visibleQueue();
  const rest = ui.showOlder ? [...recent, ...older] : recent;
  return [...needsCategoryVideos(), ...rest];
}

function renderBulk() {
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

function toggleSelectAll() {
  const shown = shownVideos();
  const allOn = shown.length > 0 && shown.every((v) => ui.selected.has(v.videoId));
  if (allOn) shown.forEach((v) => ui.selected.delete(v.videoId));
  else shown.forEach((v) => ui.selected.add(v.videoId));
  renderPending();
}

async function discardOne(video) {
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

async function processOne(video) {
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

async function watchJob(jobId, videos) {
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

function markJob(videos, status) {
  videos.forEach((v) => ui.jobs.set(v.videoId, status));
  if (status === "done") {
    const ids = new Set(videos.map((v) => v.videoId));
    ui.queue = ui.queue.filter((v) => !ids.has(v.videoId));
  }
  renderPending();
}

async function onCategoryChange(video, category) {
  if (!category) return;
  await api.updatePendingCategory(video.videoId, category);
  const row = ui.queue.find((v) => v.videoId === video.videoId);
  if (row) {
    row.category = category;
    row.needsCategory = false;
  }
  renderPending();
}

async function applyNeedsCategory() {
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

function renderChannels() {
  $("channels-count").textContent = String(ui.channels.length);
  const sel = $("channel-cat");
  sel.innerHTML = ui.categories.map((c) => `<option value="${c.name}">${c.name}</option>`).join("");
  const list = $("channels-list");
  const rows = [...ui.channels].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  list.innerHTML = "";
  rows.forEach((ch) => {
    const last = lastActivity(ch.id);
    const el = document.createElement("article");
    el.className = "card";
    el.style.gridTemplateColumns = "1fr";
    el.innerHTML = `
      <div>
        <div class="title">${escapeHtml(channelCardName(ch))}</div>
        <div class="meta">${escapeHtml(ch.category)} · ${escapeHtml(ch.id)}${last ? ` · last ${escapeHtml(last)}` : ""}</div>
        <div class="row-actions">
          <button type="button" class="btn discard" data-del="${escapeHtml(ch.id)}">Remove</button>
        </div>
      </div>`;
    el.querySelector("[data-del]").onclick = async () => {
      const snapshot = { ...ch };
      await api.removeChannel(ch.id);
      ui.channels = ui.channels.filter((c) => c.id !== ch.id);
      renderChannels();
      toast("Removed channel", "Undo", async () => {
        await api.updateChannel(snapshot.id, snapshot.name, snapshot.category);
        const next = await api.getChannels().catch(() => null);
        ui.channels = next || [...ui.channels, snapshot];
        renderChannels();
      });
    };
    list.appendChild(el);
  });
}

function historyRows() {
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

function renderHistoryFilters() {
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

function renderHistoryBulk() {
  const n = selectedHistory().length;
  $("history-bulk").classList.toggle("hidden", n === 0);
  $("history-bulk-label").textContent = `${n} selected`;
  const rows = historyRows();
  const allOn = rows.length > 0 && rows.every((v) => ui.historySelected.has(v.videoId));
  $("history-select-all").textContent = allOn ? "Deselect All" : "Select All";
  renderHistoryExport();
}

function exportTargets() {
  const selected = selectedHistory();
  return selected.length ? selected : historyRows();
}

function renderHistoryExport() {
  const n = selectedHistory().length;
  const notesBtn = $("history-export-notes");
  const trBtn = $("history-export-transcripts");
  if (notesBtn) notesBtn.textContent = n > 0 ? `Export ${n} note${n === 1 ? "" : "s"}` : "Export notes";
  if (trBtn) trBtn.textContent = n > 0 ? `Export ${n} transcript${n === 1 ? "" : "s"}` : "Export transcripts";
}

function toggleHistorySelectAll() {
  const rows = historyRows();
  const allOn = rows.length > 0 && rows.every((v) => ui.historySelected.has(v.videoId));
  if (allOn) rows.forEach((v) => ui.historySelected.delete(v.videoId));
  else rows.forEach((v) => ui.historySelected.add(v.videoId));
  renderHistory();
}

function selectedHistory() {
  const visible = new Set(historyRows().map((v) => v.videoId));
  return ui.history.filter((v) => ui.historySelected.has(v.videoId) && visible.has(v.videoId));
}

function exportDateStamp(iso) {
  const parsed = iso ? new Date(iso) : new Date();
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

function exportTitle(video) {
  const raw = String(video?.title || video?.videoId || "note")
    .replace(/[\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (raw || "note").slice(0, 80);
}

function exportFilename(video, kind = "note") {
  const suffix = kind === "transcript" ? "-transcript" : "";
  return `ingestor-${exportDateStamp(video?.processedAt)}-${exportTitle(video)}${suffix}.md`;
}

function noteMarkdownFile(video) {
  return `# ${video.title || video.videoId}\n\n${noteCopyText(video)}`.trim();
}

function transcriptMarkdownFile(video) {
  const timed = transcriptCues(video).length > 0;
  return `# ${video.title || video.videoId}\n\n${transcriptCopyText(video, timed)}`.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadText(filename, text) {
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

async function downloadNotes(vids, kind = "note") {
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i];
    const text = kind === "transcript" ? transcriptMarkdownFile(v) : noteMarkdownFile(v);
    await downloadText(exportFilename(v, kind), text);
    if (i < vids.length - 1) await sleep(80);
  }
}

async function saveHistoryMarkdown() {
  const vids = exportTargets();
  if (!vids.length) {
    toast("Nothing to export");
    return;
  }
  await downloadNotes(vids, "note");
  toast(`Saved ${vids.length} note${vids.length === 1 ? "" : "s"}`);
}

async function saveHistoryTranscripts() {
  const vids = exportTargets().filter((v) => hasTranscript(v) || transcriptCues(v).length);
  if (!vids.length) {
    toast("No transcripts to export");
    return;
  }
  await downloadNotes(vids, "transcript");
  toast(`Saved ${vids.length} transcript${vids.length === 1 ? "" : "s"}`);
}

function notesRemovedWith(vids) {
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

async function deleteHistoryItems(vids) {
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

function openHistoryVideos() {
  const vids = selectedHistory().filter((v) => isYoutubeNote(v));
  if (!vids.length) {
    toast("No videos in selection");
    return;
  }
  const urls = vids.map((v) => v.videoUrl || `https://www.youtube.com/watch?v=${v.videoId}`);
  urls.slice(0, 10).forEach((url) => window.open(url, "_blank"));
  if (urls.length > 10) toast(`Opened 10 of ${urls.length}`);
}

function renderHistory() {
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

function modelOptions(selected) {
  selected = normalizeModelId(selected);
  const ids = MODELS.map((m) => m.id);
  const extra = selected && !ids.includes(selected) ? [{ id: selected, name: selected }] : [];
  return [...MODELS, ...extra]
    .map((m) => `<option value="${m.id}" ${m.id === selected ? "selected" : ""}>${m.name}</option>`)
    .join("");
}

async function paintKeysStatus() {
  const el = $("keys-status");
  if (!el) return;
  if (!ui.helperOn) {
    el.textContent = "Start the helper to save a key.";
    return;
  }
  const status = await api.getSecrets().catch(() => ({ llm: false, openrouter: false, youtube: false }));
  ui.llmReady = !!(status.llm || status.openrouter);
  if (status.openrouter || status.llm) {
    el.textContent = status.youtube
      ? "OpenRouter key is on this Mac. YouTube Data API key is set."
      : "OpenRouter key is on this Mac.";
  } else {
    el.textContent = "No OpenRouter key yet — Process will not run without one.";
  }
}

async function renderSettings() {
  const state = await getState();
  $("send-tg").checked = state.uiSendTelegram !== false;
  await paintKeysStatus();
  const details = await api.getCategorisationPrompt().catch(() => ({ prompt: "", model: "" }));
  const prompt = details.prompt || details.data?.prompt || "";
  $("sys-prompt").value = prompt || DEFAULT_CAT_PROMPT;
  $("sys-model").innerHTML = modelOptions(details.model || details.data?.model || "google/gemini-3.1-flash-lite");
  const box = $("settings-cats");
  box.innerHTML = "";
  ui.categories.forEach((cat) => {
    const el = document.createElement("article");
    el.className = "card cat-card";
    el.style.gridTemplateColumns = "1fr";
    const va = cat.visualAssets || { enabled: false, kinds: [], model: VISUAL_MODELS[0], mediaResolution: "default", materialize: "index" };
    const vaModel = normalizeModelId(va.model || VISUAL_MODELS[0]);
    el.innerHTML = `
      <div>
        <button type="button" class="title" data-open aria-expanded="false">${escapeHtml(cat.name)}</button>
        <div class="cat-body hidden">
          <label class="sr-only">Category Prompt</label>
          <textarea data-prompt>${escapeHtml(cat.prompt || "")}</textarea>
          <label class="sr-only">Category Model</label>
          <select data-model aria-label="Category Model">${modelOptions(cat.model || "google/gemini-3.1-flash-lite")}</select>
          <div class="visual-row">
            <label class="visual-toggle"><input type="checkbox" data-visual-enabled ${va.enabled ? "checked" : ""}/> Visual Assets</label>
            <div class="visual-config ${va.enabled ? "" : "hidden"}">
              <div class="visual-kinds">${VISUAL_KINDS.map((k) => `
                <label class="chip kind"><input type="checkbox" data-kind="${k}" ${(va.kinds || []).includes(k) ? "checked" : ""}/> ${k}</label>`).join("")}
              </div>
              <select data-visual-model aria-label="Visual Model">${VISUAL_MODELS.map((m) => `<option value="${m}" ${m === vaModel ? "selected" : ""}>${m.replace("google/gemini-", "")}</option>`).join("")}</select>
              <label class="visual-toggle"><input type="checkbox" data-visual-high ${va.mediaResolution === "high" ? "checked" : ""}/> HIGH resolution (OCR, ~4x cost)</label>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn process" data-save>Save</button>
            <button type="button" class="btn discard" data-del>Delete</button>
          </div>
        </div>
      </div>`;
    el.querySelector("[data-open]").onclick = () => {
      const body = el.querySelector(".cat-body");
      const open = body.classList.toggle("hidden");
      el.querySelector("[data-open]").setAttribute("aria-expanded", open ? "false" : "true");
    };
    const visEnabled = el.querySelector("[data-visual-enabled]");
    visEnabled.onchange = () => {
      el.querySelector(".visual-config").classList.toggle("hidden", !visEnabled.checked);
    };
    el.querySelector("[data-save]").onclick = async () => {
      const kinds = [...el.querySelectorAll("[data-kind]")].filter((k) => k.checked).map((k) => k.dataset.kind);
      const visualAssets = visEnabled.checked
        ? {
            enabled: true,
            kinds,
            model: el.querySelector("[data-visual-model]").value,
            mediaResolution: el.querySelector("[data-visual-high]").checked ? "high" : "default",
            materialize: "index",
          }
        : undefined;
      await api.saveCategory(cat.name, el.querySelector("[data-prompt]").value, el.querySelector("[data-model]").value, visualAssets);
      toast("Saved " + cat.name);
      ui.categories = await api.getCategories();
    };
    el.querySelector("[data-del]").onclick = async () => {
      const snapshot = { ...cat, visualAssets: cat.visualAssets };
      await api.deleteCategory(cat.name);
      ui.categories = ui.categories.filter((c) => c.name !== cat.name);
      renderSettings();
      toast(`Deleted ${snapshot.name}`, "Undo", async () => {
        await api.saveCategory(snapshot.name, snapshot.prompt, snapshot.model, snapshot.visualAssets);
        ui.categories = await api.getCategories();
        renderSettings();
      });
    };
    box.appendChild(el);
  });
}

async function loadHistory() {
  ui.history = await api.getHistory().catch(() => []);
  ui.failed = await api.getFailed().catch(() => []);
  renderHistory();
}

async function loadAll() {
  await api.bootstrap();
  const [queue, channels, categories] = await Promise.all([
    api.getQueue().catch(() => []),
    api.getChannels().catch(() => []),
    api.getCategories().catch(() => []),
  ]);
  ui.queue = queue;
  ui.channels = channels;
  ui.categories = categories;
  await loadHistory();
  renderPending();
  renderChannels();
  await refreshStatus();
  hydrateChannelNames();
}

async function hydrateChannelNames() {
  if (!ui.helperOn) return;
  const rows = [
    ...ui.queue.filter((v) => isPlaceholderChannelName(v.channelName)),
    ...ui.history.filter((v) => !isSynthNote(v) && !isBranchNote(v) && isPlaceholderChannelName(v.channelName)),
  ].slice(0, 20);
  if (!rows.length) return;
  let changed = false;
  const pendingPatches = [];
  for (const video of rows) {
    try {
      const id = await api.resolveIdentity(video.videoId);
      if (!id?.channelName) continue;
      video.channelName = id.channelName;
      if (id.channelId && (!video.channelId || video.channelId === "manual_ingest")) video.channelId = id.channelId;
      if (id.title && isPlaceholderChannelName(video.title)) video.title = id.title;
      changed = true;
      if (ui.history.some((h) => h.videoId === video.videoId)) persistVideo(video).catch(() => {});
      if (ui.queue.some((q) => q.videoId === video.videoId)) {
        pendingPatches.push({
          videoId: video.videoId,
          channelName: video.channelName,
          channelId: video.channelId,
          title: video.title,
        });
      }
    } catch {
      /* oEmbed miss */
    }
  }
  if (pendingPatches.length) api.patchPending(pendingPatches).catch(() => {});
  if (changed) {
    renderPending();
    renderHistory();
  }
}

function wire() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => setTab(tab.dataset.tab);
  });
  $("settings-btn").onclick = async () => {
    setTab("settings");
    await renderSettings();
  };
  $("start-btn").onclick = startHelperFromUi;
  $("helper-pill").onclick = startHelperFromUi;
  $("note-back").onclick = () => setTab("history");
  $("note-scroll").addEventListener("click", copyUnitFromEvent);
  $("note-scroll").addEventListener("pointerdown", onCopyPointerDown);
  window.addEventListener("pointermove", onCopyPointerMove);
  window.addEventListener("pointerup", onCopyPointerUp);
  window.addEventListener("pointercancel", () => { copyDrag = null; clearCopyRange(); });
  $("composer-send").onclick = sendComposer;
  $("composer-branch-toggle").onclick = enterBranchMode;
  $("branch-back").onclick = exitBranchMode;
  $("branch-add").onclick = addBranchRow;
  $("branch-send").onclick = sendBranches;
  $("composer-tall").onclick = () => {
    ui.composerTall = !ui.composerTall;
    $("note-composer").classList.toggle("tall", ui.composerTall);
    $("composer-tall").textContent = ui.composerTall ? "Compact" : "Half Height";
  };
  $("composer-input").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendComposer();
  });
  $("doc-note").onclick = () => { ui.docMode = "note"; paintDoc(); };
  $("doc-transcript").onclick = async () => {
    ui.docMode = "transcript";
    if (ui.openNote && !transcriptCues(ui.openNote).length) await maybeLoadCues(ui.openNote, true);
    paintDoc();
  };
  $("show-ts").onchange = async (e) => {
    ui.showTimestamps = !!e.target.checked;
    if (ui.openNote) ui.openNote._cuesFailed = false;
    await setState({ [keys().showTranscriptTimes]: ui.showTimestamps });
    paintDoc();
  };
  $("desc-edit").onclick = () => { ui.descEdit = true; paintDescDraft(ui.openNote, true); };
  $("desc-preview").onclick = () => {
    if (ui.openNote) ui.openNote.descriptionBlock = $("desc-editor").value;
    ui.descEdit = false;
    paintDescDraft(ui.openNote, true);
  };
  $("desc-add").onclick = addDescToNote;
  $("desc-dismiss").onclick = dismissDesc;
  $("desc-reedit").onclick = () => {
    ui.descReedit = true;
    ui.descEdit = true;
    paintDoc();
  };
  $("show-older").onclick = () => { ui.showOlder = true; renderPending(); };
  $("select-all").onclick = toggleSelectAll;
  $("toggle-channels").onclick = () => {
    ui.showChannelFilters = !ui.showChannelFilters;
    renderFilters();
  };
  $("bulk-discard").onclick = async () => {
    const ids = [...ui.selected];
    const vids = ui.queue.filter((v) => ids.includes(v.videoId));
    ui.queue = ui.queue.filter((v) => !ids.includes(v.videoId));
    ui.selected.clear();
    renderPending();
    await api.discardVideos(ids);
    toast(`Discarded ${vids.length}`, "Undo", async () => {
      for (const video of vids) await api.restoreVideo(video);
      ui.queue.push(...vids);
      renderPending();
    });
  };
  $("bulk-gemini").onclick = () => {
    const ids = [...ui.selected];
    if (ids.length !== 1) return;
    const video = ui.queue.find((v) => v.videoId === ids[0]);
    if (video) openInGemini(video, true);
  };
  $("bulk-process").onclick = async () => {
    const vids = ui.queue.filter((v) => ui.selected.has(v.videoId) && !needsCategory(v) && hasRealCategory(v));
    if (!vids.length) {
      toast("Choose a category first.");
      return;
    }
    for (const v of vids) await processOne(v);
    ui.selected.clear();
  };
  $("needs-cat-apply").onclick = applyNeedsCategory;
  $("history-select-all").onclick = toggleHistorySelectAll;
  $("history-export-notes").onclick = saveHistoryMarkdown;
  $("history-export-transcripts").onclick = saveHistoryTranscripts;
  $("history-open").onclick = openHistoryVideos;
  $("history-delete").onclick = () => deleteHistoryItems(selectedHistory());
  $("track-btn").onclick = async () => {
    const url = $("channel-url").value.trim();
    const category = $("channel-cat").value;
    if (!url) return;
    if (!ui.helperOn) { toast("Start the helper to add a channel."); return; }
    const res = await api.addChannel(url, category);
    if (!res.success) { toast(res.error || "Could not add"); return; }
    $("channel-url").value = "";
    await loadAll();
  };
  $("history-search").oninput = () => { renderHistory(); writeHash("history"); };
  $("send-tg").onchange = (e) => setState({ [keys().sendTelegram]: e.target.checked });
  $("save-prompt").onclick = async () => {
    await api.saveCategorisationPrompt($("sys-prompt").value, $("sys-model").value);
    toast("Saved prompt");
  };
  $("add-cat").onclick = async () => {
    const name = $("new-cat-name").value.trim();
    if (!name) return;
    await api.saveCategory(name, "Analyze the transcript.", "gemini-3.1-flash-lite");
    $("new-cat-name").value = "";
    ui.categories = await api.getCategories();
    renderSettings();
  };
  const saveOr = $("save-or-key");
  if (saveOr) saveOr.onclick = async () => {
    if (!ui.helperOn) { toast("Start the helper to save a key."); return; }
    const key = $("or-key").value.trim();
    if (!key) { toast("Paste an OpenRouter key first."); return; }
    try {
      await api.saveSecrets({ openrouterApiKey: key });
      $("or-key").value = "";
      toast("OpenRouter key saved on this Mac.");
      await refreshStatus();
      await paintKeysStatus();
      renderPending();
    } catch (err) {
      toast(String(err.message || err));
    }
  };
  const saveYt = $("save-yt-key");
  if (saveYt) saveYt.onclick = async () => {
    if (!ui.helperOn) { toast("Start the helper to save a key."); return; }
    const key = $("yt-key").value.trim();
    if (!key) { toast("Paste a YouTube Data API key first."); return; }
    try {
      await api.saveSecrets({ googleApiKey: key });
      $("yt-key").value = "";
      toast("YouTube Data API key saved.");
      await paintKeysStatus();
    } catch (err) {
      toast(String(err.message || err));
    }
  };
  window.addEventListener("hashchange", () => applyHash());
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsavedWork()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

function hasUnsavedWork() {
  if (Object.values(ui.composerDrafts).some((v) => String(v || "").trim())) return true;
  const box = $("composer-input");
  if (box && box.value.trim()) return true;
  const desc = $("desc-editor");
  const draft = $("desc-draft");
  if (desc && draft && !draft.classList.contains("hidden")) {
    const saved = String(ui.openNote?.description || ui.openNote?.descriptionBlock || "");
    if (desc.value !== saved) return true;
  }
  return false;
}

let panelClosing = false;

function connectPanel() {
  if (panelClosing) return;
  const port = chrome.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener((msg) => {
    if (msg.type !== "CLOSE_PANEL") return;
    panelClosing = true;
    window.close();
  });
  port.onDisconnect.addListener(() => {
    if (panelClosing) return;
    if (!chrome.runtime?.id) return;
    setTimeout(connectPanel, 150);
  });
}
connectPanel();

chrome.runtime.sendMessage({ type: "PANEL_STATE", open: true });
window.addEventListener("pagehide", () => {
  panelClosing = true;
  chrome.runtime.sendMessage({ type: "PANEL_STATE", open: false });
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CLOSE_PANEL") {
    panelClosing = true;
    window.close();
  }
  if (msg.type === "QUEUE_UPDATED") {
    setTab("pending");
    loadAll();
  }
  if (msg.type === "GEMINI_IMPORTED") onGeminiImported(msg);
  if (msg.type === "BRANCH_PROGRESS") {
    const { index, total, status, error } = msg;
    const label = status === "sent"
      ? `Branch ${index + 1}/${total}: sent`
      : status === "failed"
      ? `Branch ${index + 1}/${total}: ${error || "failed"}`
      : `Branch ${index + 1}/${total}: ${status}`;
    $("branch-progress").textContent = label;
    $("branch-progress").classList.remove("hidden");
  }
});

async function init() {
  const state = await getState();
  ui._lastOpened = state.uiLastOpened ? new Date(state.uiLastOpened).getTime() : 0;
  ui.showTimestamps = state.uiShowTranscriptTimes !== false;
  try { wire(); } catch (err) { console.error("wire failed", err); }
  await refreshStatus();
  try {
    await loadAll();
  } catch {
    $("pending-list").innerHTML = `<div class="empty">Could not load data. Start the helper once so the extension can remember your worker login.</div>`;
  }
  if (!applyHash()) setTab(state.uiLastTab || "pending");
  await setState({ [keys().lastOpened]: new Date().toISOString() });
}

init();
