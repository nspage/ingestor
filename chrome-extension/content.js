// Same rules as app/inbox-rules.js — content scripts cannot import that ES module.
const MIN_PENDING_SECONDS = 180;
const PLACEHOLDER_CHANNEL_NAMES = [
  "",
  "unknown",
  "unknown channel",
  "visit source",
  "youtube video feed",
  "youtube",
  "untitled",
];

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function isPlaceholderChannelName(name) {
  const trimmed = decodeHtmlEntities(String(name || "")).trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_CHANNEL_NAMES.includes(trimmed.toLowerCase())) return true;
  if (/^channel-\d+$/i.test(trimmed)) return true;
  return false;
}

const HIGHLIGHT_SELECTOR = [
  "yt-lockup-view-model",
  "ytd-rich-item-renderer",
  "ytd-rich-grid-media",
  "ytd-rich-grid-slim-media",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-playlist-video-renderer",
  "ytd-reel-item-renderer",
  "ytd-movie-renderer",
  "ytd-grid-video-renderer",
].join(",");

const TITLE_SELECTOR = [
  "#video-title",
  "#video-title-link",
  "yt-formatted-string#video-title",
  ".yt-lockup-metadata-view-model__title",
  ".yt-lockup-metadata-view-model-wiz__heading-text",
  "a.yt-lockup-metadata-view-model__title",
  "h3 a",
  "h3",
].join(", ");

const CHANNEL_SELECTOR = [
  "#channel-name a",
  "ytd-channel-name a",
  ".ytd-channel-name a",
  "yt-content-metadata-view-model a",
  ".yt-content-metadata-view-model__metadata-row a",
  "yt-reel-channel-bar-view-model a",
  ".ytReelChannelBarViewModelChannelName a",
  "a.yt-core-attributed-string__link[href^='/@']",
  "a[href^='/@']",
  "a[href*='/channel/']",
].join(", ");

const DURATION_SELECTOR = [
  "ytd-thumbnail-overlay-time-status-renderer",
  "#time-status",
  "badge-shape .yt-badge-shape__text",
  ".yt-badge-shape__text",
  "yt-thumbnail-overlay-badge-view-model",
].join(", ");

const pick = {
  on: false,
  sending: false,
  selected: new Map(),
  ctx: null,
  ctxPromise: null,
  lastToggle: 0,
  gestureId: null,
};

function runtimeAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function isInvalidated(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("Extension context invalidated") || msg.includes("Receiving end does not exist");
}

async function sendRuntime(message) {
  if (!runtimeAlive()) throw new Error("Extension context invalidated.");
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    if (isInvalidated(err)) markDead();
    throw err;
  }
}

function markDead() {
  if (window.__ytpTick) {
    clearInterval(window.__ytpTick);
    window.__ytpTick = null;
  }
  showBadge("Reload this YouTube tab to use Pipeline");
}

function videoIdFromUrl() {
  const u = new URL(location.href);
  return u.searchParams.get("v") || (location.pathname.startsWith("/shorts/") ? location.pathname.split("/shorts/")[1].split(/[/?#]/)[0] : "");
}

function videoIdFromHref(href) {
  try {
    const u = new URL(href, location.origin);
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/shorts/")[1].split(/[/?#]/)[0];
    return u.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function isChannelPage() {
  return location.pathname.startsWith("/@") || location.pathname.startsWith("/channel/") || location.pathname.startsWith("/c/");
}

function watchTitle() {
  return document.querySelector("h1.ytd-watch-metadata")?.innerText || document.title;
}

function watchChannel() {
  const selectors = [
    "#upload-info .ytd-channel-name a",
    "ytd-channel-name a",
    "yt-reel-channel-bar-view-model a",
    ".ytReelChannelBarViewModelChannelName a",
    "#channel-name a",
    "a.ytp-title-channel-name",
    "ytd-reel-player-header-renderer a[href^='/@']",
    "a[href^='/@']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const name = (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    if (name && !isPlaceholderChannelName(name)) return name;
  }
  return "";
}

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

function durationSeconds(label) {
  if (!label) return null;
  const first = String(label).replace(/[\[\]]/g, "").trim().split(/\s+/)[0];
  const parts = first.split(":").map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function mainPlayerVideo() {
  return document.querySelector("#movie_player video.html5-main-video")
    || document.querySelector("#movie_player video")
    || document.querySelector("ytd-watch-flexy #ytd-player video");
}

function isAdPlaying() {
  const player = document.getElementById("movie_player");
  return !!(player && player.classList.contains("ad-showing"));
}

function watchLooksShort() {
  if (location.pathname.startsWith("/shorts/")) return true;
  if (isAdPlaying()) return false;
  const video = mainPlayerVideo();
  const seconds = video?.duration;
  if (!Number.isFinite(seconds) || seconds < 1) return false;
  return seconds < MIN_PENDING_SECONDS;
}

function ensurePanel() {
  let panel = document.getElementById("ytp-pipeline-panel");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "ytp-pipeline-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ytp-hd");
  panel.innerHTML = `
    <h2 id="ytp-hd" class="ytp-hd">ingestor</h2>
    <div id="ytp-badge" class="ytp-badge"></div>
    <div id="ytp-cats" class="ytp-cats" role="group" aria-label="Category"></div>
    <div class="ytp-row">
      <button type="button" id="ytp-send">Send to Ingestor</button>
      <button type="button" id="ytp-cancel" class="ghost">Close</button>
    </div>
  `;
  document.documentElement.appendChild(panel);
  panel.querySelector("#ytp-cancel").onclick = () => panel.classList.remove("open");
  return panel;
}

function showBadge(text) {
  const badge = document.getElementById("pipeline-inline-badge");
  if (!text) {
    if (badge) badge.remove();
    return;
  }
  let el = badge;
  if (!el) {
    el = document.createElement("div");
    el.id = "pipeline-inline-badge";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
}

function queueStatus(res) {
  if (!res?.success) return res?.error || "Failed";
  const results = res.results || [];
  if (results.length === 1) {
    const s = results[0].status;
    if (s === "exists") return "Already in pending";
    if (s === "processed") return "Already processed";
    if (s === "skipped") return results[0].error || "Skipped";
    if (s === "error") return results[0].error || "Failed";
  }
  const queued = results.filter((r) => r.status === "queued").length;
  if (queued > 1) return `Queued ${queued}`;
  if (queued === 1 && results.length > 1) return `Queued ${queued}`;
  return "Queued";
}

const watchState = {
  videoId: "",
  badge: "",
  fetching: "",
};

function setWatchBadge(videoId, text) {
  watchState.videoId = videoId || "";
  watchState.badge = text || "";
  showBadge(watchState.badge);
}

function rememberQueued(videos, res) {
  const id = videoIdFromUrl();
  if (!id || !res?.success) return;
  if (!(videos || []).some((v) => v.videoId === id)) return;
  const row = (res.results || []).find((r) => r.videoId === id);
  const status = row?.status || queueStatus(res);
  if (status === "processed") setWatchBadge(id, "Already processed");
  else if (status === "queued" || status === "exists" || status === "Queued" || status === "Already in pending") {
    setWatchBadge(id, "Already in pending");
  }
}

async function queueVideos(videos, openPanel) {
  const res = await sendRuntime({ type: "QUEUE_VIDEOS", videos, openPanel: !!openPanel });
  rememberQueued(videos, res);
  return res;
}

async function decorateWatch() {
  const id = videoIdFromUrl();
  if (!id) return;

  if (watchState.videoId === id) {
    showBadge(watchState.badge);
    return;
  }

  const video = mainPlayerVideo();
  const seconds = video?.duration;
  if (isAdPlaying() || !Number.isFinite(seconds) || seconds < 1) {
    if (watchState.videoId === id) showBadge(watchState.badge);
    return;
  }

  if (watchState.fetching === id) {
    showBadge(watchState.badge);
    return;
  }

  watchState.fetching = id;
  try {
    const ctx = await sendRuntime({ type: "PAGE_CONTEXT" });
    if (videoIdFromUrl() !== id) return;
    if ((ctx.pendingIds || []).includes(id)) {
      setWatchBadge(id, "Already in pending");
      return;
    }
    const processed = await sendRuntime({ type: "IS_PROCESSED", videoId: id });
    if (videoIdFromUrl() !== id) return;
    setWatchBadge(id, processed?.exists ? "Already processed" : "");
  } catch (err) {
    if (isInvalidated(err)) {
      markDead();
      return;
    }
    if (videoIdFromUrl() === id) setWatchBadge(id, "");
  } finally {
    if (watchState.fetching === id) watchState.fetching = "";
  }
}

function watchPayload(category, extras = {}) {
  const id = videoIdFromUrl();
  return {
    videoId: id,
    title: watchTitle(),
    channelId: extras.channelId || "manual_ingest",
    channelName: extras.channelName || watchChannel(),
    category: category || "",
    publishedAt: new Date().toISOString(),
    videoUrl: `https://www.youtube.com/watch?v=${id}`,
    addedAt: new Date().toISOString(),
    needsCategory: false,
  };
}

function openSendPanel(ctx, knownChannel) {
  const panel = ensurePanel();
  const cats = ctx.categories?.length ? ctx.categories : ["Strategy"];
  const catBox = panel.querySelector("#ytp-cats");
  const badge = panel.querySelector("#ytp-badge");
  const sendBtn = panel.querySelector("#ytp-send");
  catBox.innerHTML = "";
  sendBtn.disabled = false;
  sendBtn.textContent = "Send to Ingestor";
  if (knownChannel) {
    badge.textContent = `Will use ${knownChannel.category}`;
    catBox.style.display = "none";
  } else {
    badge.textContent = "Pick a category";
    catBox.style.display = "flex";
    cats.forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.setAttribute("aria-pressed", "false");
      b.onclick = () => {
        catBox.querySelectorAll("button").forEach((x) => {
          x.classList.remove("on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
      };
      catBox.appendChild(b);
    });
    catBox.querySelector("button")?.click();
  }
  sendBtn.onclick = async () => {
    const chosen = knownChannel?.category || catBox.querySelector("button.on")?.textContent;
    sendBtn.disabled = true;
    badge.textContent = "Sending…";
    try {
      const res = await queueVideos([
        watchPayload(chosen, knownChannel ? { channelId: knownChannel.id, channelName: knownChannel.name } : {}),
      ]);
      const msg = queueStatus(res);
      badge.textContent = msg;
      sendBtn.textContent = res?.success ? "Queued" : "Failed";
      if (res?.success) setTimeout(() => panel.classList.remove("open"), 1200);
      else sendBtn.disabled = false;
    } catch (err) {
      badge.textContent = isInvalidated(err) ? "Reload this tab" : (err.message || "Failed");
      sendBtn.textContent = "Failed";
      sendBtn.disabled = false;
    }
  };
  panel.classList.add("open");
}

function injectWatchButton() {
  if (document.getElementById("antigravity-process-btn")) return;
  const selectors = [
    "ytd-watch-metadata ytd-menu-renderer #top-level-buttons-computed",
    "ytd-watch-metadata #actions-inner #menu",
    "#top-level-buttons-computed",
    "ytd-reel-player-overlay-renderer #actions",
    "ytm-shorts-player-overlay-renderer",
  ];
  let menu = null;
  for (const s of selectors) {
    menu = document.querySelector(s);
    if (menu) break;
  }
  if (!menu) return;
  const btn = document.createElement("button");
  btn.id = "antigravity-process-btn";
  btn.className = "antigravity-btn";
  btn.textContent = "Send to Ingestor";
  btn.onclick = async () => {
    try {
      const ctx = await sendRuntime({ type: "PAGE_CONTEXT" });
      const name = watchChannel();
      const known = (ctx.channels || []).find((c) => c.name && name && c.name.toLowerCase() === name.toLowerCase());
      if (known) {
        btn.disabled = true;
        btn.textContent = "Sending…";
        const res = await queueVideos([
          watchPayload(known.category, { channelId: known.id, channelName: known.name }),
        ]);
        btn.textContent = res?.success ? (queueStatus(res) === "Queued" ? "Queued" : queueStatus(res)) : "Failed";
        if (!res?.success) btn.disabled = false;
        return;
      }
      openSendPanel(ctx, null);
    } catch (err) {
      btn.textContent = isInvalidated(err) ? "Reload tab" : "Failed";
    }
  };
  menu.insertBefore(btn, menu.firstChild);
}

function injectChannelButton() {
  if (document.getElementById("antigravity-track-btn")) return;
  if (!isChannelPage()) return;
  const box = document.querySelector("#inner-header-container #buttons") || document.querySelector("#subscribe-button");
  if (!box) return;
  const btn = document.createElement("button");
  btn.id = "antigravity-track-btn";
  btn.className = "antigravity-btn";
  btn.textContent = "Track Channel";
  btn.onclick = async () => {
    try {
      const ctx = await sendRuntime({ type: "PAGE_CONTEXT" });
      const already = (ctx.channels || []).some((c) => location.href.includes(c.id));
      if (already) {
        btn.textContent = "Already tracked";
        return;
      }
      const category = ctx.categories?.[0] || "Strategy";
      btn.textContent = "Tracking…";
      const res = await sendRuntime({
        type: "ADD_CHANNEL",
        payload: { url: location.href, category },
      });
      btn.textContent = res?.success ? `Tracking · ${res.category || category}` : "Failed";
    } catch (err) {
      btn.textContent = isInvalidated(err) ? "Reload tab" : "Failed";
    }
  };
  box.prepend(btn);
}

function textOf(el) {
  return (el?.getAttribute?.("title") || el?.textContent || "").replace(/\s+/g, " ").trim();
}

function parseFromRoot(root, videoId, href) {
  const titleEl = root.querySelector?.(TITLE_SELECTOR);
  const channelEl = root.querySelector?.(CHANNEL_SELECTOR);
  const durationEl = root.querySelector?.(DURATION_SELECTOR);
  const title = textOf(titleEl) || textOf(root.querySelector?.("a[href*='watch'], a[href*='/shorts/']")) || videoId;
  const channelName = textOf(channelEl) || "";
  const channelHref = channelEl?.getAttribute?.("href") || channelEl?.href || "";
  const channelId = (channelHref.match(/\/channel\/(UC[\w-]+)/) || [])[1] || "manual_ingest";
  const duration = textOf(durationEl);
  return {
    videoId,
    title,
    channelId,
    channelName,
    duration,
    videoUrl: href && href.includes("watch") ? href.split("&")[0] : `https://www.youtube.com/watch?v=${videoId}`,
    root,
  };
}

function hrefFromNode(node) {
  if (!node || node.nodeType !== 1) return "";
  return node.href || node.getAttribute?.("href") || node.getAttribute?.("data-href") || "";
}

function findVideoFromEvent(e) {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
  let href = "";
  let anchor = null;
  for (const node of path) {
    if (!node || node.nodeType !== 1) continue;
    const raw = hrefFromNode(node);
    if (raw && (raw.includes("watch?v=") || raw.includes("/shorts/"))) {
      href = raw;
      anchor = node;
      break;
    }
    if (node.getAttribute?.("data-video-id")) {
      const videoId = node.getAttribute("data-video-id");
      const root = node.closest?.(HIGHLIGHT_SELECTOR) || node;
      return parseFromRoot(root, videoId, `https://www.youtube.com/watch?v=${videoId}`);
    }
  }
  if (!href && e.target?.closest) {
    anchor = e.target.closest('a[href*="watch?v="], a[href*="/shorts/"]');
    href = hrefFromNode(anchor);
  }
  const videoId = videoIdFromHref(href);
  if (!videoId) return null;
  const root = (anchor && anchor.closest?.(HIGHLIGHT_SELECTOR)) || anchor || e.target;
  return parseFromRoot(root, videoId, href);
}

function pickHud() {
  let el = document.getElementById("ytp-pick-hud");
  if (el) return el;
  el = document.createElement("div");
  el.id = "ytp-pick-hud";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <span id="ytp-pick-label"></span>
    <button type="button" id="ytp-pick-send">Send to Ingestor</button>
    <button type="button" id="ytp-pick-cancel" class="ghost">Cancel</button>
  `;
  el.querySelector("#ytp-pick-send").onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    finishPick();
  };
  el.querySelector("#ytp-pick-cancel").onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    exitPick(true);
  };
  document.documentElement.appendChild(el);
  return el;
}

function updatePickHud(override) {
  const el = pickHud();
  el.classList.add("open");
  const label = el.querySelector("#ytp-pick-label");
  const send = el.querySelector("#ytp-pick-send");
  const n = pick.selected.size;
  label.textContent = override || (n
    ? `${n} selected · ⌘\u00a0⇧\u00a01 or Send to Ingestor`
    : "Pick mode · click videos · Esc to cancel");
  send.hidden = !pick.on || n === 0;
  syncLauncher();
}

function clearPickUi() {
  document.querySelectorAll(".ytp-pick-on").forEach((n) => n.classList.remove("ytp-pick-on"));
  document.documentElement.classList.remove("ytp-pick-mode");
  const hud = document.getElementById("ytp-pick-hud");
  if (hud) hud.classList.remove("open");
  syncLauncher();
}

function exitPick(cancel) {
  pick.on = false;
  pick.selected.clear();
  pick.ctx = null;
  if (cancel) clearPickUi();
}

function ensureLauncher() {
  let el = document.getElementById("ytp-pick-launch");
  if (el) return el;
  el = document.createElement("button");
  el.id = "ytp-pick-launch";
  el.type = "button";
  el.textContent = "Pick Videos";
  el.title = "⌘\u00a0⇧\u00a01";
  el.setAttribute("aria-label", "Pick Videos");
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePick();
  });
  document.documentElement.appendChild(el);
  return el;
}

function syncLauncher() {
  const el = ensureLauncher();
  el.hidden = !!pick.on;
}

async function enterPick() {
  if (pick.on || pick.sending) return;
  if (!runtimeAlive()) {
    markDead();
    return;
  }
  pick.on = true;
  pick.selected = new Map();
  document.documentElement.classList.add("ytp-pick-mode");
  updatePickHud("Pick Videos · 0 selected");
  pick.ctxPromise = sendRuntime({ type: "PAGE_CONTEXT" }).catch((err) => {
    if (isInvalidated(err)) return { helperOn: false, dead: true };
    return { helperOn: false };
  });
  pick.ctx = await pick.ctxPromise;
  if (!pick.on) return;
  if (pick.ctx?.dead) {
    exitPick(true);
    markDead();
    return;
  }
  if (!pick.ctx?.helperOn) updatePickHud("Helper is off · start it in the extension");
  else updatePickHud();
}

async function finishPick() {
  if (!pick.on || pick.sending) return;
  if (pick.ctxPromise) {
    try { pick.ctx = await pick.ctxPromise; } catch { pick.ctx = { helperOn: false }; }
  }
  if (!pick.on || pick.sending) return;
  const videos = [...pick.selected.values()];
  pick.on = false;
  pick.selected.clear();
  document.querySelectorAll(".ytp-pick-on").forEach((n) => n.classList.remove("ytp-pick-on"));
  document.documentElement.classList.remove("ytp-pick-mode");
  if (!videos.length) {
    clearPickUi();
    return;
  }
  if (!pick.ctx?.helperOn) {
    updatePickHud("Helper is off");
    setTimeout(clearPickUi, 1600);
    return;
  }
  pick.sending = true;
  updatePickHud("Sending…");
  try {
    const res = await queueVideos(videos, true);
    updatePickHud(res?.success ? `Sent ${videos.length}` : (res?.error || "Failed"));
  } catch (err) {
    updatePickHud(isInvalidated(err) ? "Reload this tab" : (err.message || "Failed"));
  }
  pick.sending = false;
  pick.ctx = null;
  setTimeout(clearPickUi, 1600);
}

function setPickHighlight(videoId, on, root) {
  const nodes = new Set();
  if (root) nodes.add(root);
  document.querySelectorAll(`[data-ytp-pick="${videoId}"]`).forEach((n) => nodes.add(n));
  nodes.forEach((el) => {
    if (!el?.classList) return;
    el.classList.toggle("ytp-pick-on", on);
    if (on) el.setAttribute("data-ytp-pick", videoId);
    else el.removeAttribute("data-ytp-pick");
  });
}

function togglePickedVideo(parsed) {
  if (!parsed?.videoId) return;
  if ((pick.ctx?.pendingIds || []).includes(parsed.videoId)) {
    updatePickHud("Already in pending");
    setTimeout(() => { if (pick.on) updatePickHud(); }, 900);
    return;
  }
  if (pick.selected.has(parsed.videoId)) {
    pick.selected.delete(parsed.videoId);
    setPickHighlight(parsed.videoId, false, parsed.root);
  } else {
    const now = new Date().toISOString();
    pick.selected.set(parsed.videoId, {
      videoId: parsed.videoId,
      title: parsed.title,
      channelId: parsed.channelId,
      channelName: parsed.channelName,
      category: "",
      publishedAt: now,
      videoUrl: parsed.videoUrl || `https://www.youtube.com/watch?v=${parsed.videoId}`,
      addedAt: now,
      duration: (parsed.duration || "").split(/\s+/)[0] || "",
      needsCategory: true,
    });
    setPickHighlight(parsed.videoId, true, parsed.root);
  }
  updatePickHud();
}

function onPickPointer(e) {
  if (!pick.on) return;
  const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
  if (path.some((n) => n?.id === "ytp-pick-hud" || n?.id === "ytp-pick-launch" || n?.id === "ytp-pipeline-panel")) return;
  const found = findVideoFromEvent(e);
  if (!found) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (typeof e.button === "number" && e.button !== 0) return;
  if (e.type === "click" || e.type === "auxclick") {
    if (pick.gestureId === found.videoId) {
      pick.gestureId = null;
      return;
    }
    togglePickedVideo(found);
    return;
  }
  if (e.type === "pointerdown" || e.type === "mousedown") {
    if (pick.gestureId === found.videoId) return;
    pick.gestureId = found.videoId;
    togglePickedVideo(found);
  }
}

function isPickHotkey(e) {
  if (e.repeat || e.altKey || !e.shiftKey) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  return e.code === "Digit1" || e.key === "1" || e.key === "!";
}

function togglePick() {
  const now = Date.now();
  if (now - pick.lastToggle < 400) return;
  pick.lastToggle = now;
  if (pick.on) finishPick();
  else enterPick();
}

function onKey(e) {
  if (e.key === "Escape" && pick.on) {
    e.preventDefault();
    exitPick(true);
    return;
  }
  if (!isPickHotkey(e) || isTypingTarget(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  togglePick();
}

async function tick() {
  if (!runtimeAlive()) {
    markDead();
    return;
  }
  try {
    ensureLauncher();
    syncLauncher();
    if (location.pathname === "/watch" || location.pathname.startsWith("/shorts/")) {
      injectWatchButton();
      await decorateWatch();
    } else if (!pick.on) {
      const badge = document.getElementById("pipeline-inline-badge");
      if (badge && badge.textContent === "Too short for ingestor") badge.remove();
    }
    if (isChannelPage()) injectChannelButton();
  } catch (err) {
    if (isInvalidated(err)) markDead();
  }
}

window.__ytpOnKey = onKey;
window.__ytpOnPointer = onPickPointer;
window.__ytpTogglePick = togglePick;

if (!window.__ytpWinBound) {
  window.__ytpWinBound = true;
  ["mousedown", "pointerdown", "click", "auxclick"].forEach((type) => {
    window.addEventListener(type, (e) => window.__ytpOnPointer?.(e), true);
  });
  window.addEventListener("keydown", (e) => window.__ytpOnKey?.(e), true);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "TOGGLE_PICK") {
    (window.__ytpTogglePick || togglePick)();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "PING_PICK") {
    sendResponse({ ok: true, alive: runtimeAlive() });
    return true;
  }
  if (msg?.type === "QUEUE_UPDATED") {
    watchState.videoId = "";
    watchState.fetching = "";
    decorateWatch();
    return;
  }
});

if (window.__ytpTick) clearInterval(window.__ytpTick);
window.__ytpTick = setInterval(() => { tick(); }, 1500);
tick();
