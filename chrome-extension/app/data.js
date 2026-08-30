import * as api from "./api.js";
import { $, toast } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { isSynthNote, isBranchNote } from "./video-info.js";
import { isPlaceholderChannelName } from "./inbox-rules.js";
import { persistVideo } from "./notes.js";
import { renderPending } from "./pending.js";
import { renderHistory } from "./history.js";
import { renderChannels } from "./channels.js";

export async function refreshStatus() {
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

export async function startHelperFromUi() {
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

export async function loadHistory() {
  ui.history = await api.getHistory().catch(() => []);
  ui.failed = await api.getFailed().catch(() => []);
  renderHistory();
}

export async function loadAll() {
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

export async function hydrateChannelNames() {
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
