# YT LLM Pipeline Assistant

An inbox for YouTube channels you already follow. New videos land in a queue. You process or discard. Gemini turns the transcript into a Markdown note. The helper runs on your computer — this is not a cloud summarizer.

Not on the Chrome Web Store. Load the unpacked extension from this repo.

## What you get

- Chrome side panel: pending queue, channels, history
- Cloudflare Worker + KV: queue, channels, and notes (your account)
- Local helper: fetches transcripts (YouTube blocks most cloud IPs) and talks to Gemini
- Optional: open the video in Gemini Web and import the thread back as a note
- Optional: Telegram delivery and a nightly email digest

## Prerequisites

- Node.js 20+
- Google Chrome (or Chromium-based) on macOS — the native helper is macOS for now
- A [Cloudflare](https://dash.cloudflare.com/) account
- A [Gemini API key](https://aistudio.google.com/apikey)

Optional: YouTube Data API key (titles/durations), Telegram bot, [Resend](https://resend.com/) for email.

## Setup

```bash
git clone https://github.com/nspage/ingestor.git
cd ingestor
cp .env.example .env
```

Edit `.env`. At minimum set `GEMINI_API_KEY`, `WORKER_BASE_URL`, `WORKER_API_SECRET`, and `PUBSUB_CALLBACK_URL`.

### 1. Deploy your worker

```bash
cd worker
cp wrangler.toml.example wrangler.toml
npx wrangler kv namespace create YT_PIPELINE
```

Paste the namespace id into `wrangler.toml`, then:

```bash
npx wrangler secret put WORKER_API_SECRET
npx wrangler deploy
```

`WORKER_BASE_URL` in `.env` must match the URL Wrangler prints. The same value goes in `PUBSUB_CALLBACK_URL` with `/youtube/pubsub` appended.

### 2. Install the helper and the extension

From the repo root:

```bash
npm install
npm run helper:install
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → choose the `chrome-extension` folder.

Open the extension side panel and click **Start helper** once so the panel can store your worker URL and token. After that you can browse the queue with the helper off.

**Process** still needs the helper (transcripts are fetched locally). **Gemini** on a pending card opens Gemini with a prefill; the extension imports the thread as a note.

## Daily use

1. Track channels from the Channels tab (or pick videos on YouTube).
2. New publishes show up in Pending.
3. Process, open in Gemini, or discard.
4. Notes live in History.

Branching from a Gemini-imported note is experimental. If it fails with "Gemini branch API changed", use Follow up instead.

You do not need Docker. Trigger.dev Cloud is not part of this path — do not deploy the helper there; YouTube will block those IPs.

## Security

Worker API routes expect `Authorization: Bearer $WORKER_API_SECRET`. Never commit `.env` or `worker/wrangler.toml`. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Nicolas S. Page. Not affiliated with YouTube, Google, or Cloudflare.
