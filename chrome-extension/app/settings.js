import * as api from "./api.js";
import { getState } from "./state.js";
import { $, toast } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { escapeHtml } from "./markdown.js";

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
export function normalizeModelId(id) {
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

export function modelOptions(selected) {
  selected = normalizeModelId(selected);
  const ids = MODELS.map((m) => m.id);
  const extra = selected && !ids.includes(selected) ? [{ id: selected, name: selected }] : [];
  return [...MODELS, ...extra]
    .map((m) => `<option value="${m.id}" ${m.id === selected ? "selected" : ""}>${m.name}</option>`)
    .join("");
}

export async function paintKeysStatus() {
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

export async function renderSettings() {
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
