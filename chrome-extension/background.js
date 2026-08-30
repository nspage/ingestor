importScripts("./app/gemini-rpc.js");
const LOCAL = "http://127.0.0.1:3000/api/extension";
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
const CONTEXT_TTL_MS = 5 * 60 * 1000;
let contextCache = null;
let contextInflight = null;
const processedCache = new Map();
const processedInflight = new Map();

let panelPort = null;

async function getPanelOpen() {
  if (panelPort) return true;
  const data = await chrome.storage.session.get("panelOpen");
  return !!data.panelOpen;
}
async function setPanelOpen(open) {
  await chrome.storage.session.set({ panelOpen: !!open });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panelPort = port;
  setPanelOpen(true);
  port.onDisconnect.addListener(() => {
    if (panelPort !== port) return;
    panelPort = null;
    setPanelOpen(false);
  });
});

async function helperUp() {
  try {
    const opts = { signal: AbortSignal.timeout(2000) };
    try { opts.targetAddressSpace = "loopback"; } catch { /* older chrome */ }
    const res = await fetch(`${LOCAL}/health`, opts);
    const data = await res.json();
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

async function bootstrap() {
  try {
    const res = await fetch(`${LOCAL}/bootstrap`);
    const data = await res.json();
    if (data.success) {
      await chrome.storage.local.set({ workerUrl: data.workerUrl, workerToken: data.token });
    }
  } catch { /* off */ }
}

async function queueVideosLocal(videos) {
  const results = [];
  for (const video of videos) {
    if (!video?.videoId) {
      results.push({ status: "error", error: "Missing videoId" });
      continue;
    }
    try {
      await workerFetch("/api/videos/pending", {
        method: "POST",
        body: JSON.stringify(video),
      });
      results.push({ videoId: video.videoId, status: "queued" });
    } catch (e) {
      results.push({ videoId: video.videoId, status: "error", error: String(e.message || e) });
    }
  }
  const queued = results.filter((r) => r.status === "queued").length;
  return {
    success: queued > 0,
    results,
    error: queued > 0 ? undefined : (results[0]?.error || "Failed to queue"),
  };
}

async function workerFetch(path, init = {}) {
  const { workerUrl, workerToken } = await chrome.storage.local.get(["workerUrl", "workerToken"]);
  if (!workerUrl || !workerToken) throw new Error("no-creds");
  const res = await fetch(`${String(workerUrl).replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerToken}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`worker ${res.status}`);
  return res.json();
}

function contextFresh() {
  return !!(contextCache && Date.now() - contextCache.at < CONTEXT_TTL_MS);
}

function invalidateKvCache() {
  contextCache = null;
  processedCache.clear();
}

async function notifyYoutubeTabs(message) {
  const tabs = await chrome.tabs.query({ url: ["*://*.youtube.com/*"] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, message, () => void chrome.runtime.lastError);
  }
}

async function onQueueMutated() {
  invalidateKvCache();
  chrome.runtime.sendMessage({ type: "QUEUE_UPDATED" }, () => void chrome.runtime.lastError);
  await notifyYoutubeTabs({ type: "QUEUE_UPDATED" });
}

async function loadPageContextData() {
  let channels = [];
  let pending = [];
  let categories = [];
  try {
    channels = await workerFetch("/api/channels");
    pending = await workerFetch("/api/videos/pending");
    categories = await workerFetch("/api/categories");
  } catch {
    /* Worker creds missing or down — YouTube page gets an empty context */
  }
  const names = (categories || []).map((c) => c.name || c).filter(Boolean);
  if (names.length) await chrome.storage.local.set({ cachedCategories: names });
  contextCache = {
    at: Date.now(),
    channels: Array.isArray(channels) ? channels : [],
    pendingIds: (pending || []).map((v) => v.videoId).filter(Boolean),
    categories: names,
  };
  return contextCache;
}

async function pageContext() {
  const on = await helperUp();
  if (on) await bootstrap();
  if (!contextFresh()) {
    if (!contextInflight) {
      contextInflight = loadPageContextData().finally(() => { contextInflight = null; });
    }
    await contextInflight;
  }
  return {
    helperOn: on,
    channels: contextCache?.channels || [],
    pendingIds: contextCache?.pendingIds || [],
    categories: contextCache?.categories || [],
  };
}

async function isVideoProcessed(videoId) {
  if (!videoId) return false;
  const hit = processedCache.get(videoId);
  if (hit?.exists) return true;
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return false;
  if (processedInflight.has(videoId)) return processedInflight.get(videoId);
  const pending = (async () => {
    try {
      const data = await workerFetch(`/api/videos/processed/${videoId}`);
      const exists = !!data.exists;
      processedCache.set(videoId, { exists, at: Date.now() });
      return exists;
    } catch {
      return false;
    } finally {
      processedInflight.delete(videoId);
    }
  })();
  processedInflight.set(videoId, pending);
  return pending;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "PAGE_CONTEXT") {
    (async () => {
      try {
        sendResponse(await pageContext());
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  if (request.type === "IS_PROCESSED") {
    (async () => {
      try {
        const exists = await isVideoProcessed(request.videoId);
        sendResponse({ exists });
      } catch (e) {
        sendResponse({ exists: false });
      }
    })();
    return true;
  }

  if (request.type === "INVALIDATE_CONTEXT") {
    invalidateKvCache();
    notifyYoutubeTabs({ type: "QUEUE_UPDATED" });
    return;
  }

  if (request.type === "QUEUE_VIDEOS") {
    (async () => {
      try {
        const on = await helperUp();
        if (!on) {
          sendResponse({ success: false, error: "Helper is off. Open the extension and click Start Helper." });
          return;
        }
        await bootstrap();
        const videos = request.videos || (request.payload ? [request.payload] : []);
        const data = await queueVideosLocal(videos);
        if (data?.success) await onQueueMutated();
        if (request.openPanel) {
          const windowId = _sender.tab?.windowId;
          if (windowId != null) {
            await setPanelOpen(true);
            await chrome.sidePanel.open({ windowId }).catch(() => {});
          }
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.type === "ADD_CHANNEL") {
    (async () => {
      try {
        const res = await fetch(`${LOCAL}/add-channel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.payload),
        });
        const data = await res.json();
        if (data?.success) invalidateKvCache();
        sendResponse(data);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.type === "START_HELPER") {
    chrome.runtime.sendNativeMessage("com.nspage.ytpipeline", { action: "start" }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ success: true, ...(response || {}) });
    });
    return true;
  }

  if (request.type === "GET_CATEGORIES") {
    (async () => {
      const ctx = await pageContext();
      sendResponse({ success: true, categories: ctx.categories });
    })();
    return true;
  }

  if (request.type === "PANEL_STATE") {
    (async () => {
      await setPanelOpen(request.open);
    })();
    return true;
  }

  if (request.type === "GEMINI_IMPORT") {
    (async () => {
      try {
        sendResponse(await importGeminiNote(request, _sender));
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (request.type === "GEMINI_FOLLOWUP") {
    (async () => {
      try {
        sendResponse(await sendGeminiFollowup(request.text, request.videoId, request.geminiChatUrl));
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (request.type === "GEMINI_BRANCH") {
    (async () => {
      try {
        sendResponse(await handleGeminiBranch(request));
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});

const TAB_SESSIONS_KEY = "geminiTabSessions";
chrome.storage.local.remove("branchSessions");

async function readGeminiSession() {
  const { geminiSession } = await chrome.storage.local.get("geminiSession");
  return geminiSession && typeof geminiSession === "object" ? geminiSession : null;
}

async function writeGeminiSession(session) {
  await chrome.storage.local.set({ geminiSession: session });
}

async function readTabSessions() {
  const data = await chrome.storage.session.get(TAB_SESSIONS_KEY);
  return data[TAB_SESSIONS_KEY] && typeof data[TAB_SESSIONS_KEY] === "object"
    ? data[TAB_SESSIONS_KEY]
    : {};
}

async function writeTabSession(tabId, session) {
  if (tabId == null) return;
  const all = await readTabSessions();
  all[String(tabId)] = session;
  await chrome.storage.session.set({ [TAB_SESSIONS_KEY]: all });
}

async function readTabSession(tabId) {
  if (tabId == null) return null;
  const all = await readTabSessions();
  return all[String(tabId)] || null;
}

async function removeTabSession(tabId) {
  if (tabId == null) return;
  const all = await readTabSessions();
  if (!(String(tabId) in all)) return;
  delete all[String(tabId)];
  await chrome.storage.session.set({ [TAB_SESSIONS_KEY]: all });
}

function isBranchSession(session) {
  return session?.kind === "branch" || String(session?.videoId || "").startsWith("brn_");
}

async function sessionForImport(tabId) {
  const tabSession = await readTabSession(tabId);
  if (tabSession?.videoId) return { session: tabSession, source: "tab" };
  const global = await readGeminiSession();
  if (!global?.videoId) return { session: null, source: null };
  if (tabId != null && global.tabId != null && global.tabId !== tabId) {
    return { session: null, source: "wrong-tab" };
  }
  return { session: global, source: "global" };
}

async function persistImportedSession(session, source) {
  if (session?.tabId != null) await writeTabSession(session.tabId, session);
  const global = await readGeminiSession();
  const sameVideo = global?.videoId === session.videoId;
  if (source === "global" || sameVideo) await writeGeminiSession(session);
}

function snapshotVideo(video) {
  if (!video || !video.videoId) return null;
  return {
    videoId: video.videoId,
    title: video.title,
    channelId: video.channelId,
    channelName: video.channelName,
    category: video.category,
    publishedAt: video.publishedAt,
    videoUrl: video.videoUrl,
    addedAt: video.addedAt,
    duration: video.duration,
    processedAt: video.processedAt,
    ...(video.geminiChatUrl ? { geminiChatUrl: video.geminiChatUrl } : {}),
    ...(Array.isArray(video.sourceVideoIds) ? { sourceVideoIds: video.sourceVideoIds } : {}),
    ...(video.branchSource ? { branchSource: video.branchSource } : {}),
  };
}

function geminiConversationUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)gemini\.google\.com$/i.test(u.hostname)) return "";
    const m = u.pathname.match(/^(?:\/u\/\d+)?\/app\/([^/]+)\/?$/);
    return m && m[1] ? `${u.origin}${u.pathname.replace(/\/$/, "")}` : "";
  } catch {
    return "";
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importGeminiNote(request, sender) {
  const markdown = String(request.markdown || "").trim();
  if (!markdown) return { success: false, error: "empty-thread" };

  const tabId = sender?.tab?.id;
  const found = await sessionForImport(tabId);
  if (found.source === "wrong-tab") return { success: false, error: "wrong-tab" };
  let session = found.session;
  if (!session?.videoId) return { success: false, error: "no-session" };

  if (tabId != null) {
    if (session.tabId == null) session = { ...session, tabId };
    else if (session.tabId !== tabId) return { success: false, error: "wrong-tab" };
  }

  const auto = !!request.auto;
  const branch = isBranchSession(session);
  if (auto) {
    const isPanelOpen = await getPanelOpen();
    if (!isPanelOpen) return { success: false, skipped: "panel-closed" };
    if (!session.fromPending && !branch) return { success: false, skipped: "history" };
    if (session.autoImported) return { success: false, skipped: "already" };
  }

  let tabUrl = sender?.tab?.url || "";
  if (session.tabId != null) {
    try {
      const tab = await chrome.tabs.get(session.tabId);
      if (tab?.url) tabUrl = tab.url;
    } catch { /* closed */ }
  }
  const chatUrl = geminiConversationUrl(tabUrl) || geminiConversationUrl(session.geminiChatUrl) || "";

  await bootstrap();
  const pending = snapshotVideo(session.video) || { videoId: session.videoId };
  const processedAt = session.processedAt || pending.processedAt || new Date().toISOString();
  const firstSave = !session.autoImported;
  const completed = firstSave && !!session.fromPending && !branch;
  const turns = Array.isArray(request.turns) ? request.turns : [];
  const processed = {
    ...pending,
    analysis: markdown,
    analysisTurns: turns,
    transcript: "",
    processedAt,
    cost: 0,
    analysisSource: "gemini-web",
  };
  const url = chatUrl || geminiConversationUrl(pending.geminiChatUrl);
  if (url) processed.geminiChatUrl = url;

  await workerFetch("/api/videos/processed", {
    method: "POST",
    body: JSON.stringify(processed),
  });

  if (completed) {
    try {
      await workerFetch("/api/videos/pending", {
        method: "DELETE",
        body: JSON.stringify({ videoIds: [session.videoId] }),
      });
    } catch { /* note is saved even if pending delete fails */ }
    invalidateKvCache();
    await notifyYoutubeTabs({ type: "QUEUE_UPDATED" });
  }

  session = {
    ...session,
    autoImported: true,
    processedAt,
    ...(url ? { geminiChatUrl: url } : {}),
    video: {
      ...(session.video || pending),
      processedAt,
      ...(url ? { geminiChatUrl: url } : {}),
    },
  };
  await persistImportedSession(session, found.source);

  chrome.runtime.sendMessage({
    type: "GEMINI_IMPORTED",
    auto,
    completed,
    firstSave,
    kind: session.kind || (branch ? "branch" : ""),
    video: processed,
    pending,
  }, () => void chrome.runtime.lastError);

  return { success: true, auto, completed, firstSave, updated: !firstSave };
}

async function sendToGeminiTab(tabId, prompt, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await tabMessage(tabId, { type: "GEMINI_FOLLOWUP", text: prompt });
      if (res?.success) return { success: true };
    } catch { /* content script not ready */ }
    await delay(400);
  }
  return { success: false, error: "send-failed" };
}

async function liveGeminiTab(session, videoId) {
  if (!session?.tabId) return null;
  if (videoId && session.videoId && session.videoId !== videoId) return null;
  try {
    const tab = await chrome.tabs.get(session.tabId);
    if (tab && /gemini\.google\.com/i.test(tab.url || "")) return tab;
  } catch { /* closed */ }
  return null;
}

async function findGeminiTab(chatUrl) {
  const want = geminiChatId(chatUrl);
  if (!want) return null;
  try {
    const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
    return tabs.find((t) => geminiChatId(t.url) === want) || null;
  } catch {
    return null;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done(false), 15000);
    function done(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(!!ok);
    }
    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === "complete" && /gemini\.google\.com/i.test(tab.url || "")) done(true);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    (async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.status === "complete" && /gemini\.google\.com/i.test(tab.url || "")) done(true);
      } catch { /* empty */ }
    })();
  });
}

async function bindSessionTab(session, videoId, tabId, chatUrl) {
  const next = {
    ...(session || {}),
    videoId: videoId || session?.videoId,
    tabId,
    geminiChatUrl: chatUrl || session?.geminiChatUrl || "",
  };
  await writeTabSession(tabId, next);
  const global = await readGeminiSession();
  if (!global || global.videoId === next.videoId) await writeGeminiSession(next);
}

async function findTabSessionByVideo(videoId) {
  if (!videoId) return null;
  const all = await readTabSessions();
  for (const s of Object.values(all)) {
    if (s?.videoId !== videoId) continue;
    const tab = await liveGeminiTab(s, videoId);
    if (tab) return { session: s, tab };
  }
  return null;
}

async function sendGeminiFollowup(text, videoId, storedChatUrl) {
  const prompt = String(text || "").trim();
  if (!prompt) return { success: false, error: "empty" };
  const tabHit = await findTabSessionByVideo(videoId);
  const global = await readGeminiSession();
  const session = tabHit?.session
    || (global?.videoId === videoId ? global : null)
    || global;
  const id = String(videoId || session?.videoId || "");
  const chatUrl = geminiConversationUrl(storedChatUrl)
    || geminiConversationUrl(session?.geminiChatUrl)
    || "";

  if (tabHit?.tab) {
    const sent = await sendToGeminiTab(tabHit.tab.id, prompt, 3);
    if (sent.success) {
      await bindSessionTab(tabHit.session, id, tabHit.tab.id, chatUrl || geminiConversationUrl(tabHit.tab.url));
      return { success: true };
    }
  }

  const live = await liveGeminiTab(session, id);
  if (live) {
    const sent = await sendToGeminiTab(live.id, prompt, 3);
    if (sent.success) {
      await bindSessionTab(session, id, live.id, chatUrl || geminiConversationUrl(live.url));
      return { success: true };
    }
    return { success: false, error: "send-failed" };
  }

  const existing = await findGeminiTab(chatUrl);
  if (existing) {
    const sent = await sendToGeminiTab(existing.id, prompt, 3);
    if (sent.success) {
      await bindSessionTab(session, id, existing.id, chatUrl || geminiConversationUrl(existing.url));
      return { success: true };
    }
    return { success: false, error: "send-failed" };
  }

  if (chatUrl) {
    const tab = await chrome.tabs.create({ url: chatUrl, active: true });
    if (!tab?.id) return { success: false, error: "send-failed" };
    await waitForTabComplete(tab.id);
    const sent = await sendToGeminiTab(tab.id, prompt, 15);
    if (sent.success) {
      await bindSessionTab(session, id, tab.id, chatUrl);
      return { success: true };
    }
    return { success: false, error: "send-failed" };
  }

  return { success: false, error: "thread-gone" };
}

function tabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function activeYoutubeTab(tab) {
  if (tab?.id && /youtube\.com/i.test(tab.url || "")) return tab;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find((t) => /youtube\.com/i.test(t.url || "")) || tabs[0];
}

async function togglePickOnTab(tab) {
  const target = await activeYoutubeTab(tab);
  if (!target?.id || !/youtube\.com/i.test(target.url || "")) return;
  try {
    await tabMessage(target.id, { type: "TOGGLE_PICK" });
    return;
  } catch {
    /* content script missing or invalidated — inject a fresh copy */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: target.id }, files: ["content.css"] });
    await tabMessage(target.id, { type: "TOGGLE_PICK" });
  } catch (err) {
    console.warn("pick-videos inject failed", err);
  }
}

function openPipelinePanel(tab) {
  const open = (opts) => chrome.sidePanel.open(opts).catch((err) => console.warn("sidePanel.open failed", err));
  if (tab?.windowId != null) {
    open({ windowId: tab.windowId });
    return;
  }
  if (tab?.id != null) {
    open({ tabId: tab.id });
    return;
  }
  chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
    if (win?.id != null) open({ windowId: win.id });
  });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "pick-videos") {
    togglePickOnTab(tab);
    return;
  }
  if (command !== "toggle-pipeline") return;
  if (panelPort) {
    panelPort.postMessage({ type: "CLOSE_PANEL" });
    return;
  }
  openPipelinePanel(tab);
});

chrome.tabs.onRemoved.addListener((closedId) => {
  removeTabSession(closedId);
});

function branchRpcError(err) {
  const msg = err?.message || String(err);
  if (/token-parse-failed|rpc-.*-no-data|no-response-ids/.test(msg)) {
    return "Gemini branch API changed";
  }
  return msg;
}

function reportBranchProgress(payload) {
  chrome.runtime.sendMessage({ type: "BRANCH_PROGRESS", ...payload }, () => void chrome.runtime.lastError);
}

async function handleGeminiBranch(request) {
  const { conversationId, branches, video } = request;
  if (!conversationId || !branches?.length) {
    return { success: false, error: "missing-params" };
  }
  if (branches.length > 3) {
    return { success: false, error: "max-3-branches" };
  }

  let tokens;
  let responseIds;
  try {
    tokens = await getTokens();
    responseIds = await loadResponseIds(tokens, conversationId);
  } catch (err) {
    return { success: false, error: branchRpcError(err) };
  }
  if (!responseIds.length) {
    return { success: false, error: "Gemini branch API changed" };
  }
  const lastResponseId = responseIds[responseIds.length - 1];

  const results = [];
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    try {
      const { newConvoId } = await branch(tokens, conversationId, lastResponseId);
      const newUrl = `https://gemini.google.com/app/${newConvoId}?pipeline_branch=1`;
      const chatUrl = geminiConversationUrl(newUrl);
      const branchVideoId = `brn_${Date.now().toString(36)}_${i}`;
      const suffix = (b.prompt || "").split("\n")[0].slice(0, 60);
      const snapshot = {
        videoId: branchVideoId,
        title: `${video?.title || "Note"} — ${suffix}`,
        sourceVideoIds: video?.videoId ? [video.videoId] : [],
        category: video?.category || "",
        geminiChatUrl: chatUrl,
        branchSource: {
          conversationId,
          responseId: lastResponseId,
          parentVideoId: video?.videoId,
        },
      };

      const tab = await chrome.tabs.create({ url: newUrl, active: true });
      if (!tab?.id) throw new Error("send-failed");
      const session = {
        videoId: branchVideoId,
        tabId: tab.id,
        autoImported: false,
        fromPending: false,
        kind: "branch",
        processedAt: null,
        video: snapshot,
        geminiChatUrl: chatUrl,
        prompt: b.prompt,
      };
      await writeTabSession(tab.id, session);
      await waitForTabComplete(tab.id);
      const sent = await sendToGeminiTab(tab.id, b.prompt, 15);
      if (!sent.success) throw new Error("send-failed");

      results.push({ index: i, success: true, branchVideoId, newConvoId, tabId: tab.id });
      reportBranchProgress({
        index: i,
        total: branches.length,
        status: "sent",
        branchVideoId,
      });
      // Gemini rejects back-to-back branch RPCs without a short gap.
      if (i < branches.length - 1) await delay(1500);
    } catch (err) {
      const error = branchRpcError(err);
      results.push({ index: i, success: false, error });
      reportBranchProgress({
        index: i,
        total: branches.length,
        status: "failed",
        error,
      });
    }
  }

  return { success: results.some((r) => r.success), results };
}
