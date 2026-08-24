(() => {
  const KEY = "geminiPrefill";
  const STABLE_MS = 1000;
  const isBranch = new URLSearchParams(location.search).has("pipeline_branch");
  let autoTried = false;
  let imported = false;
  let lastThread = "";
  let awaitingFollowup = false;
  let stableTimer = null;
  let branchBaseline = null;

  function composer() {
    return document.querySelector('div[contenteditable="true"][role="textbox"]');
  }

  function fill(box, promptText, opts = {}) {
    box.focus();
    box.textContent = promptText;
    box.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: promptText,
    }));
    if (!opts.keepKey) {
      if (location.search) history.replaceState(null, "", `${location.origin}${location.pathname}`);
      chrome.storage.local.remove(KEY);
    }
    return true;
  }

  function fillOnce(promptText) {
    const box = composer();
    return box ? fill(box, promptText) : false;
  }

  function start(promptText) {
    if (!promptText) return;
    if (fillOnce(promptText)) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (fillOnce(promptText) || attempts >= 20) clearInterval(timer);
    }, 500);
  }

  function cellText(td) {
    return (td.innerText || "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  }

  function tableToGfm(table) {
    const rows = [...table.querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map(cellText)
    ).filter((r) => r.length);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => {
      const next = r.slice();
      while (next.length < width) next.push("");
      return next;
    };
    const fmt = (r) => `| ${pad(r).join(" | ")} |`;
    const sep = `| ${Array(width).fill("---").join(" | ")} |`;
    const [head, ...body] = rows;
    return `${fmt(head)}\n${sep}${body.length ? `\n${body.map(fmt).join("\n")}` : ""}`;
  }

  function childrenMd(el) {
    return [...el.childNodes].map(nodeToMarkdown).join("");
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "button") return "";
    if (tag === "table") return `\n\n${tableToGfm(node)}\n\n`;
    if (tag === "br") return "\n";
    if (tag === "p" || tag === "div") {
      const inner = childrenMd(node).trim();
      return inner ? `\n\n${inner}\n\n` : "";
    }
    if (/^h[1-4]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${childrenMd(node).trim()}\n\n`;
    if (tag === "li") {
      const parent = node.parentElement?.tagName.toLowerCase();
      const bullet = parent === "ol" ? "1. " : "- ";
      return `${bullet}${childrenMd(node).trim()}\n`;
    }
    if (tag === "ul" || tag === "ol") return `\n\n${childrenMd(node)}\n\n`;
    if (tag === "pre") return `\n\n\`\`\`\n${(node.innerText || "").trim()}\n\`\`\`\n\n`;
    if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") {
      return `\`${(node.innerText || "").replace(/`/g, "")}\``;
    }
    if (tag === "strong" || tag === "b") return `**${childrenMd(node)}**`;
    if (tag === "em" || tag === "i") return `*${childrenMd(node)}*`;
    if (tag === "a") return childrenMd(node);
    if (tag === "tr" || tag === "td" || tag === "th" || tag === "thead" || tag === "tbody") return "";
    return childrenMd(node);
  }

  function tidyMd(text) {
    return String(text || "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function turnMarkdown(el) {
    const root = el.querySelector(".markdown, .markdown-main-panel, message-content, .query-text, .user-query-text") || el;
    const structured = tidyMd(nodeToMarkdown(root));
    if (structured && (root.querySelector("table") || structured.includes("| --- |"))) return structured;
    if (structured) return structured;
    return tidyMd((root.innerText || "").replace(/\n{3,}/g, "\n\n"));
  }

  function scrapeTurns() {
    const nodes = [...document.querySelectorAll("user-query, model-response, [data-message-author-role]")];
    const turns = [];
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const attr = (el.getAttribute("data-message-author-role") || "").toLowerCase();
      let role = "model";
      if (attr === "user" || attr === "human" || tag === "user-query") role = "user";
      else if (attr === "model" || attr === "assistant" || tag === "model-response") role = "model";
      const markdown = turnMarkdown(el);
      if (!markdown) continue;
      const prev = turns[turns.length - 1];
      if (prev && prev.role === role) prev.markdown = tidyMd(`${prev.markdown}\n\n${markdown}`);
      else turns.push({ role, markdown });
    }
    return turns;
  }

  function threadMarkdown(turns) {
    return (turns || scrapeTurns()).map((t) => `## ${t.role === "user" ? "You" : "Gemini"}\n\n${t.markdown}`).join("\n\n");
  }

  function modelCount() {
    return scrapeTurns().filter((t) => t.role === "model").length;
  }

  function isStreaming() {
    const stop = [...document.querySelectorAll("button")].find((b) => /stop generating/i.test(b.getAttribute("aria-label") || b.textContent || ""));
    if (stop && stop.offsetParent !== null) return true;
    return !!document.querySelector("[aria-busy='true']");
  }

  function sendButton() {
    return [...document.querySelectorAll("button")].find((b) => {
      const label = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("mattooltip") || ""}`;
      return /send( message)?/i.test(label) && !b.disabled;
    });
  }

  function sendFollowup(text) {
    const box = composer();
    if (!box || !text) return false;
    fill(box, text, { keepKey: true });
    const btn = sendButton();
    if (btn) btn.click();
    else {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
    awaitingFollowup = true;
    lastThread = threadMarkdown();
    return true;
  }

  function ensureButton() {
    let btn = document.getElementById("ytp-gemini-import");
    if (btn) return btn;
    const style = document.createElement("style");
    style.textContent = `
      #ytp-gemini-import {
        position: fixed; right: 16px; bottom: 24px; z-index: 2147483646;
        background: #6b75d6; color: #fff; border: 0; border-radius: 999px;
        padding: 10px 14px; font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.25);
      }
      #ytp-gemini-import:disabled { opacity: .6; cursor: default; }
    `;
    document.documentElement.appendChild(style);
    btn = document.createElement("button");
    btn.id = "ytp-gemini-import";
    btn.type = "button";
    btn.textContent = "Import to Pipeline";
    btn.onclick = () => importThread(false);
    document.documentElement.appendChild(btn);
    return btn;
  }

  function paintButton() {
    if (modelCount() < 1) return;
    if (isBranch && !imported && branchBaseline != null && modelCount() <= branchBaseline) return;
    const btn = ensureButton();
    btn.textContent = imported ? "Update note" : "Import to Pipeline";
  }

  async function importThread(auto) {
    const turns = scrapeTurns();
    const markdown = threadMarkdown(turns);
    if (!markdown) {
      if (!auto) ensureButton().textContent = "Nothing to import";
      return;
    }
    const btn = ensureButton();
    if (!auto) {
      btn.disabled = true;
      btn.textContent = imported ? "Updating…" : "Importing…";
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: "GEMINI_IMPORT",
        markdown,
        turns,
        auto: !!auto && !awaitingFollowup,
      });
      if (res?.success) {
        imported = true;
        awaitingFollowup = false;
        lastThread = markdown;
        btn.textContent = "Update note";
        if (isBranch && location.search) {
          history.replaceState(null, "", `${location.origin}${location.pathname}`);
        }
      } else if (res?.skipped) {
        paintButton();
      } else if (!auto) {
        btn.textContent = res?.error === "no-session" ? "Open Gemini from Pending" : "Import failed";
      }
    } catch {
      if (!auto) btn.textContent = "Import failed";
    } finally {
      btn.disabled = false;
      if (imported) btn.textContent = "Update note";
    }
  }

  function onMaybeFinished() {
    if (isBranch && branchBaseline == null && !isStreaming() && modelCount() >= 1) {
      branchBaseline = modelCount();
    }
    paintButton();
    if (isStreaming() || modelCount() < 1) return;
    const markdown = threadMarkdown();
    if (!markdown || markdown === lastThread) return;
    if (isBranch && (branchBaseline == null || modelCount() <= branchBaseline)) return;
    if (awaitingFollowup) {
      lastThread = markdown;
      importThread(false);
      return;
    }
    if (autoTried || imported) return;
    autoTried = true;
    lastThread = markdown;
    importThread(true);
  }

  function observe() {
    const kick = () => {
      clearTimeout(stableTimer);
      stableTimer = setTimeout(onMaybeFinished, STABLE_MS);
    };
    const observer = new MutationObserver(kick);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    kick();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "GEMINI_FOLLOWUP") return;
    if (isBranch && branchBaseline == null && modelCount() >= 1) branchBaseline = modelCount();
    const ok = sendFollowup(String(msg.text || "").trim());
    sendResponse({ success: ok });
    return true;
  });

  if (!isBranch) {
    chrome.storage.local.get(["geminiSession"], (data) => {
      imported = !!data.geminiSession?.autoImported;
    });
    const fromQuery = new URLSearchParams(location.search).get("q")
      || new URLSearchParams(location.search).get("prompt");
    if (fromQuery) start(fromQuery);
    else chrome.storage.local.get(KEY, (data) => start(data[KEY]));
  }

  observe();
})();
