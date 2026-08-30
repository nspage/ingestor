import * as api from "./api.js";
import { $, toast } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { escapeHtml } from "./markdown.js";
import { channelCardName, videoTime } from "./video-info.js";
import { formatWhen } from "./duration.js";

export function lastActivity(channelId) {
  const times = [
    ...ui.queue.filter((v) => v.channelId === channelId).map(videoTime),
    ...ui.history.filter((v) => v.channelId === channelId).map((v) => new Date(v.processedAt || 0).getTime()),
  ].filter(Boolean);
  if (!times.length) return "";
  return formatWhen(new Date(Math.max(...times)).toISOString());
}

export function renderChannels() {
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
