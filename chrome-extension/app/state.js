const KEYS = {
  lastTab: "uiLastTab",
  lastOpened: "uiLastOpened",
  sendTelegram: "uiSendTelegram",
  showTranscriptTimes: "uiShowTranscriptTimes",
  workerUrl: "workerUrl",
  workerToken: "workerToken",
};

export async function getState(extra = []) {
  return chrome.storage.local.get([
    KEYS.lastTab,
    KEYS.lastOpened,
    KEYS.sendTelegram,
    KEYS.showTranscriptTimes,
    KEYS.workerUrl,
    KEYS.workerToken,
    ...extra,
  ]);
}

export async function setState(patch) {
  return chrome.storage.local.set(patch);
}

export function keys() {
  return KEYS;
}
