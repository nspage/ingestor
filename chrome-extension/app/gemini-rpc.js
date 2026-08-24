/**
 * Gemini batchexecute RPC client.
 * Runs in the extension context (background or sidepanel).
 * Uses host_permissions + Chrome's cookie jar for auth.
 */

const GEMINI_ORIGIN = "https://gemini.google.com";
const BATCHEXECUTE = "/_/BardChatUi/data/batchexecute";

// ── Token extraction ────────────────────────────────────────

let tokenCache = null;
const TOKEN_TTL = 10 * 60 * 1000; // 10 min

async function getTokens(force = false) {
  if (!force && tokenCache && Date.now() - tokenCache.at < TOKEN_TTL) {
    return tokenCache.tokens;
  }
  const res = await fetch(`${GEMINI_ORIGIN}/app`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`gemini-page ${res.status}`);
  const html = await res.text();

  const at = extract(html, /\"SNlM0e\"\s*:\s*\"([^\"]+)\"/);
  const bl = extract(html, /\"cfb2h\"\s*:\s*\"([^\"]+)\"/);
  const sid = extract(html, /\"FdrFJe\"\s*:\s*\"(-?\d+)\"/);

  if (!at || !bl) throw new Error("token-parse-failed");
  const tokens = { at, bl, sid };
  tokenCache = { tokens, at: Date.now() };
  return tokens;
}

function extract(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : "";
}

// ── Low-level RPC ───────────────────────────────────────────

let reqCounter = Math.floor(Math.random() * 90000) + 10000;

async function rpc(tokens, rpcId, payload, sourcePath) {
  const params = new URLSearchParams({
    rpcids: rpcId,
    "source-path": sourcePath || "/app",
    bl: tokens.bl,
    "f.sid": tokens.sid || "",
    hl: "en",
    _reqid: String(reqCounter++),
  });

  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[rpcId, JSON.stringify(payload), null, "generic"]]]),
    at: tokens.at,
  });

  const res = await fetch(`${GEMINI_ORIGIN}${BATCHEXECUTE}?${params}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`rpc-${rpcId} ${res.status}`);
  return parseRpcResponse(await res.text(), rpcId);
}

function parseRpcResponse(text, rpcId) {
  // batchexecute format: )]}'\n\nSIZE\n[[wrb.fr, rpcId, DATA_JSON, ...]]\n...
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("[[")) continue;
    try {
      const outer = JSON.parse(line);
      const entry = outer.find((e) => e[0] === "wrb.fr" && e[1] === rpcId);
      if (entry && entry[2]) return JSON.parse(entry[2]);
    } catch { /* try next line */ }
  }
  throw new Error(`rpc-${rpcId}-no-data`);
}

// ── Conversation load (extract response IDs) ───────────────

async function loadResponseIds(tokens, convoId) {
  // hNvQHb loads a conversation and returns turn data with response IDs
  const data = await rpc(
    tokens,
    "hNvQHb",
    [`c_${convoId}`, 10, null, 1, [1], [4], null, 1],
    `/app/${convoId}`
  );

  return extractResponseIds(data);
}

function extractResponseIds(data) {
  // Walk the nested arrays to find r_ prefixed IDs
  const ids = [];
  const walkForIds = (obj) => {
    if (!obj) return;
    if (typeof obj === "string" && /^r_[a-f0-9]{16}$/.test(obj)) {
      ids.push(obj);
    }
    if (Array.isArray(obj)) obj.forEach(walkForIds);
  };
  walkForIds(data);
  return [...new Set(ids)];
}

// ── Branch ──────────────────────────────────────────────────

async function branch(tokens, convoId, responseId) {
  const result = await rpc(
    tokens,
    "KDNZr",
    [`c_${convoId}`, responseId.startsWith("r_") ? responseId : `r_${responseId}`],
    `/app/${convoId}`
  );
  const raw = result?.[0]?.[0];
  if (typeof raw !== "string" || !raw) throw new Error("rpc-KDNZr-no-data");
  const newId = raw.replace(/^c_/, "");
  if (!newId) throw new Error("rpc-KDNZr-no-data");
  return { newConvoId: newId, title: result[0][1] || "" };
}
