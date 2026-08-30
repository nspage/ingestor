import { $, toast } from "./panel-dom.js";
import { ui } from "./panel-state.js";
import { gfmToTsv } from "./markdown.js";
import { stashComposer } from "./gemini-thread.js";

let copyDrag = null;
let copyAnchor = null;

export function copyUnitText(el) {
  const encoded = el.getAttribute("data-copy");
  return encoded ? decodeURIComponent(encoded) : (el.innerText || "").trim();
}

export function copyUnitsInScroll() {
  return [...($("note-scroll")?.querySelectorAll(".copy-unit") || [])];
}

export function clearCopyRange() {
  copyUnitsInScroll().forEach((el) => el.classList.remove("on"));
  $("note-scroll")?.classList.remove("copy-dragging");
}

export function paintCopyRange(from, to) {
  const units = copyUnitsInScroll();
  const a = units.indexOf(from);
  const b = units.indexOf(to);
  if (a < 0 || b < 0) return [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const slice = units.slice(lo, hi + 1);
  units.forEach((el) => el.classList.toggle("on", slice.includes(el)));
  return slice;
}

export function joinCopyUnits(els) {
  let out = "";
  for (let i = 0; i < els.length; i += 1) {
    const text = copyUnitText(els[i]);
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    const sameLine = els[i].parentElement
      && els[i].parentElement === els[i - 1].parentElement
      && /^(P|LI|H1|H2|H3|H4)$/.test(els[i].parentElement.tagName)
      && !els[i].classList.contains("cue");
    const cue = els[i].classList.contains("cue") || els[i - 1].classList.contains("cue");
    out += sameLine ? " " : cue ? "\n" : "\n\n";
    out += text;
  }
  return out;
}

export function unitFromPoint(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const unit = el?.closest?.(".copy-unit");
  if (!unit || !$("note-scroll")?.contains(unit)) return null;
  return unit;
}

export async function copyText(text, count, message) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(message || (count > 1 ? `Copied ${count}` : "Copied"));
  } catch {
    toast("Could not copy");
  }
}

export function composerVisible() {
  return !!$("note-composer") && !$("note-composer").classList.contains("hidden");
}

export function insertAtComposer(text) {
  if (ui.branchMode) {
    const areas = [...$("branch-list").querySelectorAll("textarea")];
    const focused = areas.find((a) => a === document.activeElement) || areas[areas.length - 1];
    if (!focused) return false;
    const start = focused.selectionStart ?? focused.value.length;
    const end = focused.selectionEnd ?? start;
    focused.value = `${focused.value.slice(0, start)}${text}${focused.value.slice(end)}`;
    const pos = start + text.length;
    focused.focus();
    focused.setSelectionRange(pos, pos);
    const idx = areas.indexOf(focused);
    if (idx >= 0) ui.branchPrompts[idx] = focused.value;
    return true;
  }
  const box = $("composer-input");
  if (!box || !text) return false;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.value = `${box.value.slice(0, start)}${text}${box.value.slice(end)}`;
  const pos = start + text.length;
  box.focus();
  box.setSelectionRange(pos, pos);
  stashComposer();
  return true;
}

export function copyUnitFromEvent(e) {
  if (copyDrag) return;
  const tsvBtn = e.target.closest(".table-tsv");
  if (tsvBtn && $("note-scroll")?.contains(tsvBtn)) {
    e.preventDefault();
    const wrap = tsvBtn.closest(".md-table-wrap");
    copyText(gfmToTsv(wrap ? copyUnitText(wrap) : ""), 1, "Copied TSV");
    return;
  }
  if (e.target.closest("button, a, textarea, input, select")) return;
  if (e.metaKey || e.ctrlKey) return;
  const unit = e.target.closest(".copy-unit");
  if (!unit) return;
  e.preventDefault();
  if (e.shiftKey && copyAnchor) {
    const selected = paintCopyRange(copyAnchor, unit);
    copyText(joinCopyUnits(selected), selected.length);
    setTimeout(clearCopyRange, 350);
    return;
  }
  copyAnchor = unit;
  const text = copyUnitText(unit);
  if (e.altKey && composerVisible() && insertAtComposer(text)) {
    navigator.clipboard.writeText(text).catch(() => {});
    toast("Inserted");
    return;
  }
  copyText(text, 1);
}

export function onCopyPointerDown(e) {
  if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return;
  if (e.target.closest("button, a, textarea, input, select")) return;
  const unit = e.target.closest(".copy-unit");
  if (!unit) return;
  e.preventDefault();
  copyDrag = { start: unit, last: unit };
  $("note-scroll")?.classList.add("copy-dragging");
  paintCopyRange(unit, unit);
}

export function onCopyPointerMove(e) {
  if (!copyDrag) return;
  const unit = unitFromPoint(e);
  if (!unit) return;
  copyDrag.last = unit;
  paintCopyRange(copyDrag.start, unit);
}

export function onCopyPointerUp() {
  if (!copyDrag) return;
  const selected = paintCopyRange(copyDrag.start, copyDrag.last || copyDrag.start);
  copyDrag = null;
  copyText(joinCopyUnits(selected), selected.length);
  clearCopyRange();
}

export function cancelCopyDrag() {
  copyDrag = null;
  clearCopyRange();
}
