const GITHUB = "https://github.com/nspage/ingestor";

const howFigure = document.querySelector("[data-how-figure]");
const howImg = howFigure?.querySelector("img");
const howCaption = howFigure?.querySelector("figcaption");
const howSteps = [...document.querySelectorAll(".how-step")];

function setHow(step) {
  if (!howImg || !step) return;
  howSteps.forEach((s) => s.setAttribute("aria-current", s === step ? "true" : "false"));
  const src = step.dataset.src;
  const alt = step.dataset.alt || "";
  const pos = step.dataset.pos || "top";
  const cap = step.dataset.cap || "";
  if (howImg.getAttribute("src") !== src) howImg.src = src;
  howImg.alt = alt;
  howImg.style.objectPosition = pos;
  if (howCaption) howCaption.textContent = cap;
}

howSteps.forEach((step) => {
  step.addEventListener("click", () => setHow(step));
  step.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setHow(step);
    }
  });
});

const initial = howSteps.find((s) => s.getAttribute("aria-current") === "true") || howSteps[2];
setHow(initial);

const form = document.getElementById("waitlist-form");
const msg = document.getElementById("waitlist-msg");

function showMsg(text, kind) {
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.dataset.kind = kind;
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  if (data.get("company")) {
    showMsg("You are on the list.", "ok");
    form.reset();
    return;
  }
  const email = String(data.get("email") || "").trim();
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await fetch("api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      showMsg("You are on the list.", "ok");
      form.reset();
    } else {
      showMsg("That email did not go through. Try again.", "err");
    }
  } catch {
    showMsg("That email did not go through. Try again.", "err");
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll("[data-github]").forEach((a) => {
  if (!a.getAttribute("href")) a.setAttribute("href", GITHUB);
});
