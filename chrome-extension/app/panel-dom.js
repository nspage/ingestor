export function $(id) { return document.getElementById(id); }

export function reduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function scrollBehavior() {
  return reduceMotion() ? "auto" : "smooth";
}

export function toast(message, actionLabel, onAction) {
  const el = $("toast");
  el.replaceChildren();
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "text-btn";
    btn.textContent = actionLabel;
    btn.onclick = () => { onAction(); el.classList.add("hidden"); };
    el.appendChild(btn);
  }
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 10000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
