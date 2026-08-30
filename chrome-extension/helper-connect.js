/** Classic script: pings the helper even if the module bundle fails to load. Chrome 150+ may prompt for loopback on the first click. */
(function () {
  const HEALTH = "http://127.0.0.1:3000/api/extension/health";
  const HOST = "com.nspage.ytpipeline";

  function $(id) {
    return document.getElementById(id);
  }

  function paint(on, text) {
    const pill = $("helper-pill");
    const label = $("helper-label");
    const start = $("start-btn");
    if (label) label.textContent = text;
    if (pill) {
      pill.classList.toggle("on", !!on);
      pill.classList.toggle("off", !on);
      pill.disabled = false;
    }
    if (start) start.classList.toggle("hidden", !!on);
  }

  function fetchHealth() {
    const opts = { signal: AbortSignal.timeout(2500) };
    try { opts.targetAddressSpace = "loopback"; } catch { /* older chrome */ }
    return fetch(HEALTH, opts).then((r) => r.json()).then((d) => !!(d && d.ok));
  }

  async function ping() {
    try {
      if (await fetchHealth()) {
        paint(true, "Helper on");
        return true;
      }
    } catch { /* blocked or down */ }
    paint(false, "Helper off");
    return false;
  }

  function nativeStart() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(HOST, { action: "start" }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  async function start() {
    paint(false, "Starting…");
    await nativeStart();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await ping()) return;
    }
    paint(false, "Helper off");
  }

  const pill = $("helper-pill");
  const startBtn = $("start-btn");
  if (pill) pill.addEventListener("click", (e) => { e.preventDefault(); start(); });
  if (startBtn) {
    startBtn.classList.remove("hidden");
    startBtn.addEventListener("click", (e) => { e.preventDefault(); start(); });
  }
  ping();

  window.addEventListener("error", (e) => {
    const meta = $("status-meta");
    if (meta && /api\.js|sidepanel\.js/.test(String(e.filename || e.message || ""))) {
      meta.textContent = "Panel script error — reload the extension";
    }
  });
})();
