# Multimodal asset extraction for category-specific videos

**Status:** partially implemented (2026-08-29): slices 1–3 + eval tooling are live — `visualAssets` per category (Worker + KV + extension settings), locate pass in `process-video.ts`, asset strip in notes, `scripts/visual-eval.ts`. **Not done:** slice 0 eval (run it before enabling categories), slice 4 stills, slice 5 landing-page work.

Written 2026-08-28. Reopen by starting at [Eval before product UI](#0-eval-before-product-ui-1-2-days).

---

## What this is

Today **ingestor** turns YouTube videos into markdown notes from **transcripts only**. Category prompts (Tactical, Strategy, etc.) already exist, and each category can pick a Gemini model — currently `gemini-3.1-flash-lite` by default, text in / text out.

This document covers what it would take, product and development, to run a **multimodal pass** on specific categories so the note also captures **visual assets** (slides, UI, diagrams, code on screen, charts) instead of only spoken content.

It is an assessment, not an implementation commit.

---

## Constraint that shapes everything

**Gemini 3.6 Flash and 3.7 Flash accept video. They only return text.**

They can:

- Watch a public YouTube URL (or an uploaded file)
- Point at timestamps (`MM:SS`)
- Classify what is on screen (slide, UI, diagram, code, chart, talking-head)
- OCR / describe the frame
- Emit structured JSON via `responseSchema`

They cannot:

- Crop a PNG out of the video
- Return image bytes

So “extract assets” is two jobs:

1. **Locate + reconstruct** — Gemini finds unique on-screen objects and rebuilds them as markdown
2. **Materialize** (optional) — local `yt-dlp` + `ffmpeg` actually cut stills

Skipping (2) still produces a useful product: a **reconstruction pass** inside the note — unique on-screen objects (slides, diagrams, UI, code, charts) rebuilt as markdown tables/lists/code with a timestamp link for audit. Doing (2) is the real extraction pipeline and is a larger, legally sharper step.

Do not confuse this with **Gemini Omni Flash** (`gemini-omni-1.1-flash`). That generates/edits video. Wrong model family.

---

## Current pipeline (gap)

| Step | Today | Missing for assets |
|---|---|---|
| Ingest | PubSub → KV pending | — |
| Classify | Channel category or per-video pick | No “this category has visuals worth saving” flag |
| Process | Local helper fetches captions → Gemini text prompt → markdown in KV | No video part in the Gemini request |
| Note UI | History markdown, Gemini Web import, thumbnails of the *video* only | No in-note stills, no timestamp gallery |
| Storage | KV analysis blobs | KV cannot hold image binaries (25 MB value cap; no R2 today) |
| Models in the picker | 3.1 Flash Lite, 3 Flash, 3 Pro, 2.x | `gemini-3.6-flash` and `gemini-3.7-flash` are not listed |

Gemini Web already exists as a **human** visual path (open the video in gemini.google.com, import the thread). This feature is the **API** equivalent: structured, category-gated, repeatable.

---

## Product

### Job to be done

For videos where the value is **on screen, not just spoken** (tutorials, slide talks, tool walkthroughs, framework diagrams), the note should keep those objects as first-class knowledge: a markdown **reconstruction** of each unique on-screen object (table, field list, code block, diagram map) plus a timestamp link so a human can audit it against the video. The timestamp is a footnote, not the product.

Talking-head / podcast / news-roundup videos should stay on the cheap transcript path. Running video tokens on every Process would be wasteful and noisy.

### What counts as an asset

The unit of work is a **unique visual object**, not a frame. A slide or diagram that stays on screen while the speaker zooms, pans, highlights, or talks over it is ONE asset — the model watches the whole sequence and reconstructs the FULL object (every labeled region, node, row, field), not the zoomed subset. Keep a closed type list. The model must skip talking heads, b-roll, intro/outro cards, and lower thirds, and keep an object only if the reconstruction adds structure the transcript note would not already have.

| Type | Typical source category | Why keep it |
|---|---|---|
| `slide` | Strategy, Ideation, talks | Deck pages, title cards with a claim |
| `diagram` | Strategy, Tactical | 2x2s, system maps, whiteboards |
| `ui` | Tactical, second brain | Software walkthroughs, settings, Obsidian graphs |
| `code` | Tactical | IDE / terminal / config that the SOP refers to |
| `chart` | News/Roundup, Strategy | Stats, market charts |
| `product` | News, Ideation | Device / UI of a thing being reviewed |
| `on_screen_text` | **short text extract** | Scrolling Shorts that show a prompt, email, tweet, or notes. Reconstruct the full document from the scroll. |

Hard cap per video: **8 unique objects**, strongest first. Zero is a success. Prefer one complete diagram over eight fragments.

### Category policy (opt-in, not global)

Add a per-category **visual mode**, stored next to `prompt` and `model` in KV:

```
visualAssets: {
  enabled: boolean,
  kinds: ["slide","diagram","ui","code","chart","product"],
  model: "gemini-3.7-flash",
  mediaResolution: "high" | "default",  // high only when OCR/code/slides matter
  materialize: "index" | "stills"
}
```

Recommended defaults for the prompts in `categories.json`:

| Category | Enable? | Kinds | Why |
|---|---|---|---|
| **Tactical** | Yes | ui, code, diagram | Highest yield. SOPs without the screen are incomplete. |
| **Strategy** | Yes | slide, diagram, chart | Frameworks are often drawn, not said. |
| **second brain** | Yes | ui | The whole point is the tool surface. |
| **Ideation** | Optional | slide, product | Whiteboards / competitor shots; more false positives. |
| **News/Roundup** | No (v1) | — | Mostly talking head + lower-third; skip unless a later eval says otherwise. |
| **short text extract** | Yes (ships on) | on_screen_text | Scrolling Shorts with a prompt or block of text. Visual-first; captions optional. |

Process stays one click. If the category has `visualAssets.enabled`, the helper runs a second pass after (or instead of merging into) the transcript analysis. Pending cards can show a small “visual” chip so the extra cost is visible before you hit Process.

### Note UX

In History, below the markdown:

- **Asset strip**: compact index only — type pill, timestamp, title, max 8; no OCR/caption dump. The reconstruction itself lives in the note markdown.
- Click timestamp → open YouTube at that time (`&t=125s`)
- **Appendix format (v1):** one `## On screen` heading, then one `### {title}` subsection per object: `[05:08](https://www.youtube.com/watch?v=VIDEO_ID&t=308s) · chart`, followed by the reconstruction as **raw markdown** (a real table, bullet hierarchy, code block, or diagram map — never a prose summary, never quoted/inline-coded, never flattened to one line). Full YouTube links so the daily email and Telegram doc render correctly; no relative image refs until v2 has an email/R2 story.
- Export: include image files next to the `.md` when materialize is on; otherwise export the appendix markdown

Empty state: “No reconstructable on-screen objects” is a success, not a failure.

### What not to build in v1

- A global asset library / DAM across videos
- Bounding-box crops (full-frame stills first; crop is a second image call)
- Replacing transcript analysis with video-only analysis (speech still carries the SOP / mental model)
- Auto-running on every pending video
- Relative image refs in the markdown appendix until v2 has an email/R2 story
- Gemini Omni / Veo (generation, not understanding)

---

## Model choice

| Model | Role |
|---|---|
| **`gemini-3.7-flash`** | Default for the visual pass. GA, native multimodal, structured output, thinking, 1M context. Intro pricing through 2026-12-31: **$0.75 / 1M in, $3.75 / 1M out** (then 2×). Stronger than 3.6 on multimodal/agentic work at half 3.6’s original price. |
| **`gemini-3.6-flash`** | Fallback if 3.7 regressions or regional availability. Same video API. |
| **`gemini-3.1-flash-lite`** | Keep for transcript analysis and classification. Too weak / wrong price-quality for dense frames. |

Settings for the visual pass:

- `thinkingLevel`: `low` or `medium` (medium only if eval shows missed reconstructions; high burns output tokens on a watch-and-transcribe task)
- `responseMimeType`: `application/json` + a strict schema
- Default video sampling: **1 fps** (Gemini default). Raise fps only if eval shows missed slide cuts.
- `mediaResolution`:
  - **default / low (70 tok/frame)** for “is this a diagram?”
  - **HIGH (280 tok/frame)** for Tactical/code/slides — Google’s own guidance: HIGH is for text-heavy video / OCR
- Clip long videos with `videoMetadata.startOffset` / `endOffset` (limits: ~45 min with audio, ~1 h without, at default resolution)

### How the video gets to Gemini

| Path | Use | Limits |
|---|---|---|
| **YouTube URL** (`file_data.file_uri = https://youtube.com/watch?v=…`) | v1 locate pass | **Public videos only** (unlisted/private fail). Feature is in **preview**; Google says pricing/limits may change. Free tier: 8 h/day; paid: no duration cap. |
| File API upload | Fallback if URL fails, or when materializing anyway | Need a local download first |
| Inline base64 | Skip | < 100 MB, short clips only |

YouTube URL is the product-shaped path: no download, fits “not a cloud scraper,” works for tracked public channels. Unlisted / members-only / region-blocked videos degrade to transcript-only plus a visible “visual pass skipped” note.

---

## Cost (order of magnitude)

Gemini 3 video ≈ **70 tokens/sec** at default, **280 tokens/sec** at HIGH, plus ~32 audio tok/s, plus thinking/output.

| Video | Resolution | Input tokens (approx) | Intro input $ | Post-2027 input $ |
|---|---|---|---|---|
| 15 min tutorial | default | ~63k | ~$0.05 | ~$0.09 |
| 15 min tutorial | HIGH (OCR) | ~250k | ~$0.19 | ~$0.38 |
| 45 min talk | HIGH | ~750k | ~$0.56 | ~$1.13 |

Plus output/thinking (a few thousand tokens) and the existing lite transcript call (~cents).

A daily diet of 5 Tactical videos at HIGH is roughly **$1/day** at intro rates, **$2/day** after Jan 2027 — fine if gated by category; painful if global.

Context caching is worth it only if you re-query the same video (follow-up / branch). Single Process: skip cache.

Update `calculateCost` in `process-video.ts` — it still uses 2.x-era Flash/Pro/Lite prices and would under-report 3.7 badly.

---

## Architecture (fits the existing helper)

Keep the local-first rule: the helper on the machine talks to Gemini. The Worker stays a KV store. Do not send video bytes through Cloudflare.

```
Process (category.visualAssets.enabled)
  1. Existing transcript pass → markdown  (lite model)
  2. Visual locate + reconstruct pass
       contents: [ { file_data: youtubeUrl },
                   { text: category visual prompt + transcript } ]
       model: gemini-3.7-flash
       structured JSON → assets[] (unique objects, markdown reconstructions)
  3. Merge assets into ProcessedVideo + append ## On screen to analysis
  4. Optional materialize: yt-dlp → ffmpeg -ss <t> -frames:v 1 → PNG
       store files on disk; KV holds { ts, type, title, path }
  5. Side panel renders compact strip; appendix markdown renders inline
```

The locate pass gets the transcript as a second text part alongside the video — so it avoids duplicating spoken content and can name objects the speaker names. It is explicitly NOT there so the model can write narration captions: the reconstruction must add structure (a table, field list, code block, slide hierarchy, diagram map) the transcript does not have.

### Suggested JSON schema (locate pass)

```json
{
  "assets": [
    {
      "t": "05:08",
      "tEnd": "07:42",
      "type": "chart",
      "title": "NanoClaw vs OpenClaw",
      "reconstruction": "| | NanoClaw | OpenClaw |\n|---|---|---|\n| Runtime TS lines | ~29,300 | 434,453 |\n| Direct runtime deps | 12 | 70 |",
      "completeness": "full",
      "confidence": 0.86
    }
  ]
}
```

Prompt rules: identity is semantic (same object under camera motion), not temporal — zoom/pan on the same slide is ONE asset; reconstruct from the whole sequence; type-specific markdown; drop anything whose reconstruction would restate the transcript in prose; max 8; zero is a success. A per-asset 4000-char cap guards against runaway output.

### Storage

- **Index-only (v1):** `assets[]` on the existing analysis KV record. No new infra.
- **Stills (v2):** local dir e.g. `~/Library/Application Support/yt-pipeline/assets/{videoId}/`. Helper serves them to the extension (`http://127.0.0.1:3000/api/extension/assets/...`). KV never holds PNGs.
- R2 is only needed if Telegram/email must attach stills while the helper is off. Defer.

### Materialize (v2) extras

- `yt-dlp` + `ffmpeg` as helper dependencies (or bundled)
- YouTube ToS: downloading is the sharp edge. Product copy should stay “personal notes,” never redistribute stills
- Delete stills with the history item
- Fail closed: if download fails, keep the index and mark `materializeStatus: "skipped"`

---

## Development work (realistic slices)

### 0. Eval before product UI (~1–2 days)

Pick 8–12 already-processed videos (3 Tactical, 3 Strategy, 2 second-brain, 2 News). For each, call 3.7 Flash with the YouTube URL and a draft schema. Score by hand: precision (junk frames), recall (missed slides), timestamp accuracy, OCR usefulness, schema-parse success rate (truncation shows up here).

**Kill criteria:** if Tactical precision < ~70%, recall < ~60%, or timestamps are consistently >2s off, do not ship UI — retune prompt/fps/resolution first.

Also confirm YouTube URL works on the actual channels you track (age-gated, members, unlisted).

### 1. Model + category config (~0.5 day)

- Add `gemini-3.6-flash` / `gemini-3.7-flash` to `MODELS` in `sidepanel.js`
- Persist `visualAssets` on category records (`worker/src/index.ts` POST `/api/categories`, `kv-client`, settings card toggle + kinds)

### 2. Locate pass in the helper (~1.5–2 days)

- `callGemini` in `process-video.ts` today sends `{ parts: [{ text }] }` only — extend to video `file_data` + `generationConfig.responseSchema`
- **Un-hardcode `generationConfig`**: today it is `maxOutputTokens: 4096, temperature: 0.3` inline. Thinking tokens draw from the same output budget — thinking + a 12-asset JSON response can truncate. When that happens the current code throws "Empty response from Gemini", which would kill the whole Process instead of skipping gracefully. Needs: parameterized output cap, `thinkingLevel`, `responseSchema`, and a `finishReason` check treated as a graceful-skip trigger (fall back to transcript-only).
- **Read path — without this the flag silently does nothing:**
  - `categoriesMap` in `process-video.ts` is built as `{ prompt, model }` — thread `visualAssets` through it
  - `ProcessedVideo` in `config.ts` needs an `assets` field
- Transcript as second text part in the locate request
- Category visual prompt (separate from the transcript prompt)
- Merge into `ProcessedVideo.assets` + markdown appendix (appendix format per [Downstream surfaces](#downstream-surfaces))
- Cost accounting for 3.7 rates
- Graceful skip: URL rejected / safety block / timeout → transcript note still saves

### Downstream surfaces

The `## On screen` appendix flows into every existing renderer of `analysis` uninvited:

- **Daily email** (`daily-email.ts` runs the markdown through `marked`) and **Telegram doc** render it as-is. Timestamp *links* render fine in both; relative image paths render broken.
- So in v1 the appendix uses full `https://www.youtube.com/watch?v=…&t=125s` markdown links, never relative image refs. Side panel may upgrade to stills later; email/Telegram keep working for free.
- Relative image refs are forbidden in the markdown until v2 has an email/R2 story (also on the What-not-to-build list).

### 3. History UI (~1 day)

- Asset strip in the note pane (`sidepanel.js` / `markdown.js`)
- Timestamp links
- “Visual skipped” / “0 assets” states
- Pending chip when category is visual-enabled

### 4. Stills (only if eval + v1 feel worth it) (~2–3 days)

- Local extract + helper static route
- Inline images in notes and markdown export
- Cleanup on delete
- Optional second Gemini **image** call on the still at HIGH for cleaner OCR (code/slides)

### 5. Docs / pricing honesty (~0.5 day)

- Operator guide: when to enable, cost table, public-only limit
- Landing page: do **not** advertise this until it ships; current brief is transcript-first

**Ballpark to a usable v1 (reconstruction, no stills):** ~4–6 engineering days after a successful eval.
**v2 stills:** another ~3 days plus ToS/product review.

---

## Risks

| Risk | Mitigation |
|---|---|
| YouTube URL API is preview / may start billing separately | Isolate behind the category flag; File API fallback |
| Public-only | Skip visual pass; don’t fail Process |
| 1 fps misses rapid slide decks | Eval; optional fps 2 on Tactical only |
| HIGH resolution 4× token cost | HIGH only for kinds that need OCR |
| Talking-head false positives | Closed type list + reconstruction-additive rule + cap 8 + eval |
| Markdown reconstructions + thinking exhaust the output budget | 32k output cap; MAX_TOKENS salvage parses complete assets instead of discarding the pass |
| Copyright / ToS on downloaded frames | v1 reconstruction-only; v2 personal-use, local, no share |
| KV size if someone base64s images | Never store binaries in KV |
| Helper runtime: video calls take 30–90s | Progress text in the panel; don’t block the queue UI |

---

## Recommended sequence

1. **Eval** 3.7 Flash on real Tactical + Strategy videos (YouTube URL, structured JSON, HIGH vs default).
2. If precision is good, ship **v1: locate + reconstruct** for Tactical / Strategy / second brain. Transcript pass unchanged.
3. Use it for a week. If you actually click the timestamps, then build **v2 stills**.
4. Do not enable News/Roundup until eval says it isn’t noise.

---

## Open questions (resolve when reopening)

1. **v1 = markdown reconstruction, or stills on day one?** Reconstruction is the honest Gemini capability (it can watch but not return image bytes) and avoids YouTube download. Stills are the “extracted assets” people imagine.
2. **Which categories to turn on first** — recommendation is Tactical + Strategy + second brain.
3. **Replace vs augment transcript analysis?** Recommendation: augment. Video is for frames; speech is for SOPs and mental models.
