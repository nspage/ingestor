import { getState, setState, keys } from "./state.js";

const LOCAL = "http://127.0.0.1:3000/api/extension";

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }
}

function helperFetch(path, init = {}) {
  const opts = { ...init, signal: init.signal || timeoutSignal(2000) };
  try { opts.targetAddressSpace = "loopback"; } catch { /* older chrome */ }
  return fetch(`${LOCAL}${path}`, opts);
}

export async function helperHealth() {
  try {
    const res = await helperFetch("/health");
    const data = await res.json();
    if (data && data.ok) return data;
  } catch {
    /* helper off or Chrome blocked loopback */
  }
  return { ok: false, openrouter: false, gemini: false, youtube: false, llm: false };
}

export async function helperUp() {
  const health = await helperHealth();
  return !!health.ok;
}

export async function getSecrets() {
  return localFetch("/secrets");
}

export async function saveSecrets(payload) {
  return localFetch("/secrets", { method: "POST", body: JSON.stringify(payload) });
}

export async function resolveIdentity(videoId) {
  return localFetch(`/identity/${encodeURIComponent(videoId)}`);
}

export async function bootstrap() {
  try {
    const res = await helperFetch("/bootstrap", { signal: timeoutSignal(4000) });
    const data = await res.json();
    if (data.success && data.workerUrl && data.token) {
      await setState({ [keys().workerUrl]: data.workerUrl, [keys().workerToken]: data.token });
      return true;
    }
  } catch {
    /* helper off */
  }
  return false;
}

async function creds() {
  const s = await getState();
  return { url: (s.workerUrl || "").replace(/\/$/, ""), token: s.workerToken || "" };
}

async function workerFetch(path, init = {}) {
  const { url, token } = await creds();
  if (!url || !token) throw new Error("no-creds");
  const res = await fetch(`${url}${path}`, {
    ...init,
    signal: init.signal || timeoutSignal(12000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`worker ${res.status}`);
  return res.json();
}

async function localFetch(path, init = {}) {
  const opts = {
    ...init,
    signal: init.signal || timeoutSignal(8000),
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  };
  try { opts.targetAddressSpace = "loopback"; } catch { /* older chrome */ }
  const res = await fetch(`${LOCAL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `local ${res.status}`);
  return data;
}

function invalidateContext() {
  chrome.runtime.sendMessage({ type: "INVALIDATE_CONTEXT" }, () => void chrome.runtime.lastError);
}

export async function getQueue() {
  const list = await workerFetch("/api/videos/pending");
  return Array.isArray(list) ? list : [];
}

export async function getChannels() {
  const list = await workerFetch("/api/channels");
  return Array.isArray(list) ? list : [];
}

export async function getCategories() {
  const list = await workerFetch("/api/categories");
  return Array.isArray(list) ? list : [];
}

export async function getDescription(videoId, channelId) {
  const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
  const data = await localFetch(`/description/${videoId}${q}`);
  return { description: data.description || "", descriptionBlock: data.descriptionBlock || "" };
}

export async function getTranscriptCues(videoId) {
  const data = await localFetch(`/transcript/${videoId}`);
  return data.cues || [];
}

export async function saveProcessed(video) {
  try {
    await workerFetch("/api/videos/processed", {
      method: "POST",
      body: JSON.stringify(video),
    });
  } catch {
    /* helper/worker offline — cues still live in this session */
  }
}

export async function unprocessVideo(videoId, processedAt) {
  if (!videoId) return;
  const date = processedAt ? String(processedAt).slice(0, 10) : "";
  const q = date ? `?date=${encodeURIComponent(date)}` : "";
  try {
    await workerFetch(`/api/videos/processed/${encodeURIComponent(videoId)}${q}`, {
      method: "DELETE",
    });
  } catch {
    /* worker offline */
  }
  invalidateContext();
}

export async function getHistory() {
  const list = await workerFetch("/api/videos/analyses?date=all");
  return Array.isArray(list) ? list : [];
}

export async function getFailed() {
  const list = await workerFetch("/api/videos/failed");
  return Array.isArray(list) ? list : [];
}

export async function getCost() {
  return workerFetch("/api/costs/daily");
}

export async function isProcessed(videoId) {
  const data = await workerFetch(`/api/videos/processed/${videoId}`);
  return !!data.exists;
}

export async function discardVideos(videoIds) {
  await workerFetch("/api/videos/pending", {
    method: "DELETE",
    body: JSON.stringify({ videoIds }),
  });
  invalidateContext();
}

export async function restoreVideo(video) {
  await workerFetch("/api/videos/pending", {
    method: "POST",
    body: JSON.stringify(video),
  });
  invalidateContext();
}

export async function queueVideos(videos) {
  const results = [];
  for (const video of videos) {
    try {
      await restoreVideo(video);
      results.push({ videoId: video.videoId, status: "queued" });
    } catch (e) {
      results.push({ videoId: video.videoId, status: "error", error: String(e.message || e) });
    }
  }
  const queued = results.filter((r) => r.status === "queued").length;
  if (!queued) throw new Error(results[0]?.error || "Failed to queue");
  invalidateContext();
  return { success: true, results };
}

function withCategory(video, category) {
  return { ...video, category, needsCategory: false };
}

export async function updatePendingCategory(videoId, category) {
  return updatePendingCategories([videoId], category);
}

export async function updatePendingCategories(videoIds, category) {
  const patches = videoIds.map((videoId) => withCategory({ videoId }, category));
  try {
    await workerFetch("/api/videos/pending", { method: "PATCH", body: JSON.stringify({ videos: patches }) });
  } catch {
    for (const videoId of videoIds) {
      await localFetch("/queue/update-category", {
        method: "POST",
        body: JSON.stringify({ videoId, category }),
      });
    }
  }
}

export async function patchPending(patches) {
  if (!patches?.length) return;
  try {
    await workerFetch("/api/videos/pending", { method: "PATCH", body: JSON.stringify({ videos: patches }) });
  } catch {
    /* worker offline */
  }
}

export async function processVideos(videos, sendToTelegram) {
  const payload = videos.map((v) => ({ ...v, sendToTelegram }));
  return localFetch("/process", { method: "POST", body: JSON.stringify({ videos: payload }) });
}

export async function jobStatus(jobId) {
  return localFetch(`/process/${jobId}`);
}

export async function addChannel(url, category) {
  const data = await localFetch("/add-channel", { method: "POST", body: JSON.stringify({ url, category }) });
  invalidateContext();
  return data;
}

export async function removeChannel(channelId) {
  try {
    await workerFetch("/api/channels", { method: "DELETE", body: JSON.stringify({ channelId }) });
  } catch {
    await localFetch("/remove-channel", { method: "POST", body: JSON.stringify({ channelId }) });
  }
  invalidateContext();
}

export async function updateChannel(channelId, name, category) {
  try {
    const channels = await getChannels();
    const next = channels.map((ch) => (ch.id === channelId ? { ...ch, name, category } : ch));
    if (!next.some((ch) => ch.id === channelId)) next.push({ id: channelId, name, category });
    await workerFetch("/api/channels", { method: "PUT", body: JSON.stringify(next) });
  } catch {
    await localFetch("/channels/update", {
      method: "POST",
      body: JSON.stringify({ channelId, name, category }),
    });
  }
  invalidateContext();
}

export async function saveCategory(name, prompt, model, visualAssets) {
  const body = { name, prompt, model };
  if (visualAssets) body.visualAssets = visualAssets;
  try {
    await workerFetch("/api/categories", { method: "POST", body: JSON.stringify(body) });
  } catch {
    await localFetch("/categories", { method: "POST", body: JSON.stringify(body) });
  }
}

export async function deleteCategory(name) {
  try {
    await workerFetch("/api/categories", { method: "DELETE", body: JSON.stringify({ name }) });
  } catch {
    await localFetch("/categories/delete", { method: "POST", body: JSON.stringify({ name }) });
  }
}

export async function getCategorisationPrompt() {
  return workerFetch("/api/categorisation-prompt");
}

export async function saveCategorisationPrompt(prompt, model) {
  try {
    await workerFetch("/api/categorisation-prompt", { method: "POST", body: JSON.stringify({ prompt, model }) });
  } catch {
    await localFetch("/categorisation-prompt", { method: "POST", body: JSON.stringify({ prompt, model }) });
  }
}

export async function clearFailed(videoId) {
  try {
    await workerFetch("/api/videos/failed", { method: "DELETE", body: JSON.stringify({ videoId }) });
  } catch {
    await localFetch("/failed/clear", { method: "POST", body: JSON.stringify({ videoId }) });
  }
}

export async function startHelper() {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage("com.nspage.ytpipeline", { action: "start" }, (res) => {
      if (chrome.runtime.lastError) {
        chrome.tabs.create({ url: "ytpipeline://start", active: false }).catch(() => {});
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve({ success: true, ...(res || {}) });
    });
  });
}

export async function backfill() {
  return localFetch("/backfill", { method: "POST" });
}

export { LOCAL };
