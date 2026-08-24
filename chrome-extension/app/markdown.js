const LATEX = {
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  longrightarrow: "⟶",
  longleftarrow: "⟵",
  to: "→",
  gets: "←",
  mapsto: "↦",
  times: "×",
  cdot: "·",
  bullet: "•",
  pm: "±",
  mp: "∓",
  approx: "≈",
  sim: "∼",
  neq: "≠",
  ne: "≠",
  leq: "≤",
  geq: "≥",
  le: "≤",
  ge: "≥",
  ll: "≪",
  gg: "≫",
  infty: "∞",
  ldots: "…",
  cdots: "⋯",
  checkmark: "✓",
  times: "×",
  div: "÷",
  plusmn: "±",
  degree: "°",
  text: "",
};

function replaceLatexCommands(inner) {
  return inner
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\mathrm\{([^}]*)\}/g, "$1")
    .replace(/\\([A-Za-z]+)\s*/g, (_, name) => (Object.prototype.hasOwnProperty.call(LATEX, name) ? LATEX[name] : name))
    .replace(/\s*->\s*/g, " → ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeLatex(text) {
  return String(text)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => replaceLatexCommands(inner))
    .replace(/\$([^$\n]+)\$/g, (_, inner) => replaceLatexCommands(inner))
    .replace(/\\\((.+?)\\\)/g, (_, inner) => replaceLatexCommands(inner))
    .replace(/\\\[(.+?)\\\]/g, (_, inner) => replaceLatexCommands(inner))
    .replace(/\\(rightarrow|leftarrow|Rightarrow|Leftarrow|to|times|cdot|pm|leq|geq|neq|infty|ldots)\b/g, (_, name) => LATEX[name] || name);
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitSentences(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])(?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

function normWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function hasClock(text) {
  return /\b(?:\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})\b/.test(String(text || ""));
}

export function matchCue(sentence, cues) {
  const words = normWords(sentence);
  const compact = String(sentence || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (words.length < 4 && compact.length < 25) return null;
  for (const cue of cues || []) {
    const hay = ` ${normWords(cue.text).join(" ")} `;
    if (words.length >= 4) {
      let hit = false;
      for (let n = words.length; n >= 4 && !hit; n -= 1) {
        for (let s = 0; s + n <= words.length; s += 1) {
          if (hay.includes(` ${words.slice(s, s + n).join(" ")} `)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) return cue;
    }
    const cueCompact = String(cue.text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact.length >= 25 && cueCompact.includes(compact)) return cue;
  }
  return null;
}

function copyUnits(text, transform, video) {
  const cues = transcriptCues(video);
  return splitSentences(text)
    .map((s) => {
      const rendered = inline(transform ? transform(s) : (video ? enrichDescription(s, video) : s));
      const cue = video && !hasClock(s) ? matchCue(s, cues) : null;
      const clock = cue ? formatTimestamp(cue.offset) : "";
      const copy = encodeURIComponent(clock ? `[${clock}] ${s}` : s);
      const href = cue ? watchUrlAt(video, Math.max(0, Math.floor(Number(cue.offset) / 1000))) : "";
      const ref = href
        ? `<a class="ts-ref" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(clock)}</a>`
        : "";
      return `<span class="copy-unit" data-copy="${copy}">${rendered}${ref}</span>`;
    })
    .join(" ");
}

function inline(text) {
  let html = escapeHtml(decodeLatex(text));
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

export function formatTimestamp(offsetMs) {
  const total = Math.max(0, Math.floor(Number(offsetMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function transcriptCues(video) {
  return Array.isArray(video?.cues) ? video.cues.filter((c) => c && c.text) : [];
}

export function transcriptPlain(video) {
  const stored = video?.transcript && String(video.transcript).trim();
  if (stored) return stored;
  return transcriptCues(video).map((c) => c.text).join(" ").trim();
}

export function hasTranscript(video) {
  return !!(transcriptPlain(video) || transcriptCues(video).length);
}

export function transcriptCopyText(video, timestamps) {
  const cues = transcriptCues(video);
  if (timestamps && cues.length) {
    return cues.map((c) => `[${formatTimestamp(c.offset)}] ${c.text}`).join("\n");
  }
  return transcriptPlain(video);
}

export function renderTranscript(video, timestamps = false) {
  const cues = transcriptCues(video);
  if (cues.length) {
    return `<div class="cues">${cues.map((c) => {
      const clock = formatTimestamp(c.offset);
      const text = String(c.text || "").trim();
      const copy = encodeURIComponent(`[${clock}] ${text}`);
      const href = watchUrlAt(video, Math.max(0, Math.floor(Number(c.offset) / 1000)));
      const time = timestamps
        ? `<a class="cue-time" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(clock)}</a>`
        : "";
      return `<p class="cue copy-unit" data-copy="${copy}">${time}<span class="cue-text">${escapeHtml(text)}</span></p>`;
    }).join("")}</div>`;
  }
  const text = transcriptPlain(video);
  if (!text) return "<p class='md-empty'>No transcript stored for this video.</p>";
  return `<div class="cues">${copyUnits(text)}</div>`;
}

export function watchUrlAt(video, seconds) {
  const id = video?.videoId || "";
  const base = video?.videoUrl || (id ? `https://www.youtube.com/watch?v=${id}` : "");
  if (!base) return "";
  try {
    const u = new URL(base);
    u.searchParams.set("t", String(Math.max(0, Math.floor(seconds))));
    return u.toString();
  } catch {
    return `${base}${base.includes("?") ? "&" : "?"}t=${Math.max(0, Math.floor(seconds))}`;
  }
}

export function linkDescriptionTimestamps(text, video) {
  if (!video?.videoId && !video?.videoUrl) return String(text);
  return String(text).replace(
    /\b(?:(\d{1,2}):(\d{2}):(\d{2})|(\d{1,2}):(\d{2}))\b/g,
    (full, h, hm, hs, m, s, offset, src) => {
      const before = src.slice(Math.max(0, offset - 2), offset);
      if (before === "](") return full;
      const seconds = h != null ? Number(h) * 3600 + Number(hm) * 60 + Number(hs) : Number(m) * 60 + Number(s);
      const href = watchUrlAt(video, seconds);
      if (!href) return full;
      return `[${full}](${href})`;
    }
  );
}

export function autolinkUrls(text) {
  return String(text).replace(
    /(^|[^"'(\[=])(https?:\/\/[^\s<>\[\]()]+)/g,
    (_, pre, url) => {
      const trimmed = url.replace(/[.,;:!?]+$/g, "");
      const trail = url.slice(trimmed.length);
      return `${pre}[${trimmed}](${trimmed})${trail}`;
    }
  );
}

export function enrichDescription(src, video) {
  return autolinkUrls(linkDescriptionTimestamps(src, video));
}

export function renderDescription(src, video) {
  if (src == null || String(src) === "") return "<p class='md-empty'>No description.</p>";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push("<div class='desc-gap'></div>");
      continue;
    }
    out.push(`<p>${copyUnits(line, (s) => enrichDescription(s, video), video)}</p>`);
  }
  return `<div class="desc-md">${out.join("")}</div>`;
}

export function renderPlain(src) {
  if (src == null || src === "") return "<p class='md-empty'>No description.</p>";
  return `<pre class="desc-raw">${escapeHtml(src)}</pre>`;
}

export function isGeminiNote(video) {
  if (video?.analysisSource === "gemini-web") return true;
  const turns = splitAnalysisTurns(video?.analysis, video?.analysisTurns);
  return turns.length > 1;
}

export function splitAnalysisTurns(analysis, stored) {
  if (Array.isArray(stored) && stored.length) {
    return stored.map((t) => ({
      role: t.role === "user" ? "user" : "model",
      markdown: String(t.markdown || t.text || "").trim(),
    })).filter((t) => t.markdown);
  }
  const text = String(analysis || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const re = /^## (You|Gemini)\s*$/gm;
  const hits = [...text.matchAll(re)];
  if (!hits.length) return [{ role: "model", markdown: text }];
  const turns = [];
  for (let i = 0; i < hits.length; i += 1) {
    const role = hits[i][1] === "You" ? "user" : "model";
    const start = hits[i].index + hits[i][0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const markdown = text.slice(start, end).trim();
    if (markdown) turns.push({ role, markdown });
  }
  return turns;
}

export function joinAnalysisTurns(turns) {
  return (turns || []).map((t) => {
    const label = t.role === "user" ? "You" : "Gemini";
    return `## ${label}\n\n${String(t.markdown || "").trim()}`;
  }).filter((block) => block.trim()).join("\n\n");
}

function isPipeRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSepRow(line) {
  const t = String(line || "").trim();
  if (!t.includes("-")) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(t);
}

function splitCells(line) {
  let s = String(line || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function consumeTable(lines, start) {
  if (!isPipeRow(lines[start]) || start + 1 >= lines.length || !isSepRow(lines[start + 1])) return null;
  const rows = [splitCells(lines[start])];
  let i = start + 2;
  while (i < lines.length && isPipeRow(lines[i])) {
    rows.push(splitCells(lines[i]));
    i += 1;
  }
  const width = Math.max(...rows.map((r) => r.length), 1);
  const pad = (r) => {
    const next = r.slice();
    while (next.length < width) next.push("");
    return next;
  };
  const fmt = (r) => `| ${pad(r).join(" | ")} |`;
  const sep = `| ${Array(width).fill("---").join(" | ")} |`;
  const gfm = [fmt(rows[0]), sep, ...rows.slice(1).map(fmt)].join("\n");
  const head = pad(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("");
  const body = rows.slice(1).map((r) => `<tr>${pad(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  return {
    html: `<div class="md-table-wrap copy-unit" data-copy="${encodeURIComponent(gfm)}"><button type="button" class="change table-tsv">TSV</button><div class="md-table-scroll"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`,
    next: i,
  };
}

export function gfmToTsv(gfm) {
  const lines = String(gfm || "").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    if (isSepRow(line)) continue;
    if (!isPipeRow(line) && !line.includes("|")) continue;
    rows.push(splitCells(line).join("\t"));
  }
  return rows.join("\n");
}

export function renderMarkdown(src, video) {
  if (!src || !String(src).trim()) return "<p class='md-empty'>No note for this video.</p>";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inCode = false;
  let code = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(listType === "ol" ? "</ol>" : "</ul>");
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre class="copy-unit"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      i += 1;
      continue;
    }
    if (inCode) {
      code.push(line);
      i += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level} class="copy-unit" data-copy="${encodeURIComponent(heading[2])}">${inline(video ? enrichDescription(heading[2], video) : heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${copyUnits(ul[1], null, video)}</li>`);
      i += 1;
      continue;
    }

    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${copyUnits(ol[1], null, video)}</li>`);
      i += 1;
      continue;
    }

    const table = consumeTable(lines, i);
    if (table) {
      closeList();
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i += 1;
      continue;
    }

    closeList();
    const para = [line];
    i += 1;
    while (
      i < lines.length
      && lines[i].trim()
      && !isPipeRow(lines[i])
      && !/^(#{1,4}\s|[-*+]\s|\d+\.\s|```|---+)/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${copyUnits(para.join(" "), null, video)}</p>`);
  }

  closeList();
  if (inCode) out.push(`<pre class="copy-unit"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return out.join("\n");
}
