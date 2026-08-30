# Operator guide

This is what runs after the [README](../README.md) setup. Your queue lives in **your** Cloudflare KV, not in this git repo. Tokens are billed to **your** OpenRouter (or Gemini) key.

## Pieces

1. **YouTube PubSubHubbub** notifies your worker when a tracked channel publishes.
2. **Worker + KV** store pending videos, channels, categories, and notes.
3. **Chrome extension** is the dashboard (Pending, Channels, History).
4. **Local helper** (`npm run helper:install`) fetches transcripts and calls **your** OpenRouter key when you click Process. Paste the key in the side-panel Settings (stored at `~/.ingestor/secrets.env`). Gemini via Google AI Studio is used for the visual pass through OpenRouter. Gemini Web import in the extension is unchanged.
5. **Optional delivery:** Telegram checkbox in the panel. The nightly email digest is not shipped.

## Secrets

Set worker secrets in the Cloudflare dashboard or with `npx wrangler secret put`:

- `WORKER_API_SECRET` (required)
- `GOOGLE_API_KEY` (optional, YouTube metadata)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (optional)

Local `.env` must use the same `WORKER_API_SECRET`. Paste `OPENROUTER_API_KEY` in Settings (or `.env`; falls back to `GEMINI_API_KEY`). Keep `worker/wrangler.toml` on your machine only (copy from `wrangler.toml.example`).

## Restart the helper

The side-panel **Start helper** button is a no-op if port 3000 already answers. After pulling code:

```bash
npm run helper:restart
```

Logs: `~/Library/Logs/yt-pipeline.log`.

OpenRouter visual spike (optional): `npx ts-node scripts/openrouter-spike.ts`

## PubSub leases and the pending queue

YouTube PubSubHubbub is the fast path: a push when a tracked channel publishes. Leases last five days. A worker cron every 30 minutes also polls each channel’s Atom feed (last ~15 videos) and re-subscribes, so a missed notify still lands in Pending within half an hour.

Auto-ingest skips clips under 3 minutes unless the channel’s category is **short text extract** (or that category has visual kind `on_screen_text`). Sending a Short from YouTube always queues it. The panel never auto-discards Shorts.

On YouTube pages, the floating **pacman** button (bottom right) opens the on-page actions: **Pick videos** on any page, **Track channel** on channel pages. Track sends the channel to Pending setup with the first category; watch/Shorts pages keep the **Send to Ingestor** button under the player.

## Prompts

Category prompts are stored in KV. Edit them in the extension Categories UI, or change worker defaults in `worker/src/index.ts`.

## Visual assets (per category, optional)

Categories can opt into a multimodal **reconstruction pass**: Gemini 3.7 Flash watches the public YouTube video and rebuilds up to 8 unique on-screen objects (slides, diagrams, UI, code, charts) as markdown — real tables, field lists, code blocks, diagram maps — appended under an `## On screen` heading in the note. Each object carries a timestamp link for auditing; the reconstruction is the product, not the timestamp.

- **Enable it:** Settings → category card → "Visual assets" toggle, pick kinds, save. Nothing runs for categories without the toggle. **short text extract** ships enabled with kind `on_screen_text` (HIGH resolution) for scrolling Shorts that show a prompt or block of text.
- **One object, not one frame:** a slide or diagram the speaker zooms/pans over stays ONE asset — the pass reconstructs the full object from the whole sequence. Objects whose reconstruction would just restate what the speaker says are dropped.
- **Cost:** roughly 70 tokens/sec (default) or 280 tokens/sec (HIGH resolution) plus audio — a 15-minute tutorial is ~$0.05–$0.20 per Process depending on resolution. HIGH is forced on automatically when you select code/slide/chart/diagram kinds (diagram labels are OCR-heavy).
- **Public videos only.** Unlisted, members-only, or age-gated videos degrade to transcript-only; the note shows "Visual pass skipped" instead of failing.
- **Stills (image files) are not part of this.** v1 is markdown reconstruction only; the appendix renders in the daily email and Telegram doc too.
- **Eval before enabling broadly:** `npx ts-node scripts/visual-eval.ts` (fill in real video IDs from categories you track). Kill criteria and method: [docs/multimodal-asset-extraction.md](multimodal-asset-extraction.md).

The helper is macOS-only (`~/Library/Application Support/...` native messaging). Do not delete `"key"` in `chrome-extension/manifest.json` or Start helper cannot talk to the native host.
