import { helperUp, bootstrap, startHelper, getCost } from "./app/api.js";

async function paint() {
  const on = await helperUp();
  if (on) await bootstrap();
  let money = 0;
  try {
    const cost = await getCost();
    money = cost.cost || 0;
  } catch { /* no creds yet */ }
  const pill = document.getElementById("helper-pill");
  document.getElementById("helper-label").textContent = on ? "Helper on" : "Helper off";
  document.getElementById("status-meta").textContent = `$${money.toFixed(5)} today`;
  pill.classList.toggle("on", on);
  pill.classList.toggle("off", !on);
  pill.disabled = on;
  pill.title = on ? "Helper is running" : "Start helper";
  document.getElementById("start").classList.toggle("hidden", on);
}

async function bootHelper() {
  document.getElementById("start").textContent = "Starting…";
  document.getElementById("helper-label").textContent = "Starting…";
  await startHelper();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await helperUp()) {
      await bootstrap();
      await paint();
      document.getElementById("start").textContent = "Start helper";
      return;
    }
  }
  document.getElementById("start").textContent = "Start helper";
  await paint();
}

document.getElementById("open").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) await chrome.sidePanel.open({ windowId: tab.windowId });
  window.close();
};

document.getElementById("start").onclick = bootHelper;
document.getElementById("helper-pill").onclick = () => {
  if (!document.getElementById("helper-pill").disabled) bootHelper();
};

paint();
