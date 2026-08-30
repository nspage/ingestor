import { $, toast, scrollBehavior } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { renderMarkdown, splitAnalysisTurns, joinAnalysisTurns } from "./markdown.js";
import { persistVideo, addedDescription, paintDoc } from "./notes.js";
import { geminiChatId } from "./video-info.js";

export function geminiTurns(video) {
  return splitAnalysisTurns(video?.analysis, video?.analysisTurns);
}

export function stashComposer() {
  const box = $("composer-input");
  if (!box || !ui.composerVideoId) return;
  ui.composerDrafts[ui.composerVideoId] = box.value;
}

export function loadComposer(videoId) {
  const box = $("composer-input");
  if (!box) return;
  if (ui.composerVideoId === videoId) return;
  stashComposer();
  ui.composerVideoId = videoId || "";
  box.value = (videoId && ui.composerDrafts[videoId]) || "";
}

export function enterBranchMode() {
  if (!ui.openNote?.geminiChatUrl) return;
  stashComposer();
  ui.branchMode = true;
  if (!ui.branchPrompts.length) ui.branchPrompts = [""];
  $("composer-followup").classList.add("hidden");
  $("composer-branch").classList.remove("hidden");
  $("note-composer").classList.add("branch-mode");
  paintBranchList();
}

export function exitBranchMode() {
  ui.branchMode = false;
  $("composer-branch").classList.add("hidden");
  $("composer-followup").classList.remove("hidden");
  $("note-composer").classList.remove("branch-mode");
  $("branch-progress").classList.add("hidden");
}

export function paintBranchList() {
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

export function addBranchRow() {
  if (ui.branchPrompts.length >= 3) return;
  ui.branchPrompts.push("");
  paintBranchList();
  const areas = $("branch-list").querySelectorAll("textarea");
  areas[areas.length - 1]?.focus();
}

export async function sendBranches() {
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

export function isPrefillTurn(turns, index) {
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

export function paintTurnNav(video, withTurns) {
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

export function paintGeminiThread(video) {
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

export function editTurn(video, index) {
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

export async function sendComposer() {
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
