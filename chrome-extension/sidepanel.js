import * as api from "./app/api.js";
import { getState, setState, keys } from "./app/state.js";
import { $, toast } from "./app/panel-dom.js";
import { ui } from "./app/panel-state.js";
import { transcriptCues } from "./app/markdown.js";
import { isSynthNote, isBranchNote, branchRootId, needsCategory, hasRealCategory } from "./app/video-info.js";
import { openDoc, paintDoc, paintDescDraft, addDescToNote, dismissDesc, maybeLoadCues } from "./app/notes.js";
import { sendComposer, enterBranchMode, exitBranchMode, addBranchRow, sendBranches } from "./app/gemini-thread.js";
import { copyUnitFromEvent, onCopyPointerDown, onCopyPointerMove, onCopyPointerUp, cancelCopyDrag } from "./app/copy-units.js";
import { openInGemini } from "./app/gemini-open.js";
import { renderPending, renderFilters, toggleSelectAll, applyNeedsCategory, processOne } from "./app/pending.js";
import { renderHistory, toggleHistorySelectAll, saveHistoryMarkdown, saveHistoryTranscripts, openHistoryVideos, deleteHistoryItems, selectedHistory } from "./app/history.js";
import { renderSettings, paintKeysStatus } from "./app/settings.js";
import { refreshStatus, loadAll, startHelperFromUi } from "./app/data.js";
import { setTab, applyHash, writeHash } from "./app/router.js";

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
  window.addEventListener("pointercancel", () => { cancelCopyDrag(); });
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
