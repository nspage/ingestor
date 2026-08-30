import { setState, keys } from "./state.js";
import { $ } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { stashComposer } from "./gemini-thread.js";
import { openDoc } from "./notes.js";
import { renderPending } from "./pending.js";
import { renderHistory } from "./history.js";
import { renderSettings } from "./settings.js";

export function parseHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  const qIndex = raw.indexOf("?");
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const qs = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : "");
  const parts = path.split("/").filter(Boolean);
  return { parts, qs };
}

export function writeHash(name) {
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

export function setTab(name, opts = {}) {
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

export function applyHash() {
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
