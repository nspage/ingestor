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

document.querySelectorAll("[data-github]").forEach((a) => {
  if (!a.getAttribute("href")) a.setAttribute("href", GITHUB);
});
