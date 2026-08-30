/** Keep in sync with worker/src/queue.ts. worker/test/categories-match.test.ts checks the match. */

export const CATEGORY_VOCABULARY = [
  {
    name: "Tactical",
    description: `Practical "how-to" guides, technical tutorials, software walkthroughs, coding, or step-by-step Standard Operating Procedures (SOPs).`,
  },
  {
    name: "Ideation",
    description: `Brainstorming new business ideas, identifying market "white space," niche hunting, or exploring consumer trends.`,
  },
  {
    name: "Strategy",
    description: `High-level frameworks, mental models, macro-economic shifts, philosophical "why" behind business decisions, or long-term industry positioning.`,
  },
  {
    name: "News/Roundup",
    description: `Summaries of current events, industry headlines, weekly updates, or commentary on trending topics.`,
  },
  {
    name: "second brain",
    description: `Personal Knowledge Management (PKM), productivity systems, note-taking methodologies, or "linking your thinking" workflows.`,
  },
  {
    name: "short text extract",
    description: `Shorts and clips where the value is on-screen text (prompts, emails, tweets, notes the OP scrolls through), not spoken explanation.`,
  },
];

export const CATEGORY_NAMES = CATEGORY_VOCABULARY.map((c) => c.name);

/** Default channel-classifier prompt, built from the same vocabulary as the worker. */
export const DEFAULT_CATEGORISATION_PROMPT = `You are an expert Content Strategist. Based on the following transcript snippets, classify this channel into EXACTLY one of the following ${CATEGORY_VOCABULARY.length} categories.

CATEGORIES:
${CATEGORY_VOCABULARY.map((c, i) => `${i + 1}. **${c.name}**: ${c.description}`).join("\n")}

Instructions:
- Return ONLY the category name (one of: ${CATEGORY_NAMES.join(", ")}).
- If it fits multiple, pick the most dominant one.`;

/** Map a raw LLM response or payload string onto the vocabulary; "" when it is not one. */
export function normalizeCategory(value) {
  const name = String(value || "")
    .trim()
    .replace(/[*_]/g, "");
  if (!name) return "";
  const lower = name.toLowerCase();
  return CATEGORY_NAMES.find((c) => c.toLowerCase() === lower) || "";
}
