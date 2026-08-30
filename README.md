# ingestor

An inbox for YouTube channels you already follow. New videos land in a queue. You process or discard. A local helper turns the transcript into a Markdown note. **You deploy the worker. You pay for tokens. There is no hosted queue and no shared API key.**

Not on the Chrome Web Store. Load the unpacked extension from this repo. **macOS** for the native helper (Windows/Linux is not this release).

## What you get

- Chrome side panel: pending queue, channels, history
- Cloudflare Worker + KV: **your** queue, channels, and notes
- Local helper: fetches transcripts (YouTube blocks most cloud IPs) and calls **your** OpenRouter (or Gemini) key
- Optional: open the video in Gemini Web and import the thread as a note
- Optional: Telegram delivery and a nightly email digest

Process is billed to the OpenRouter key you paste in Settings. Visual assets are off until you opt in per category (extra video tokens). `short text extract` is on by default so scrolling Shorts with on-screen prompts become notes.

## Prerequisites

- Node.js 20+
- Google Chrome (or Chromium-based) on **macOS**
- A [Cloudflare](https://dash.cloudflare.com/) account (free KV is enough)
- An [OpenRouter](https://openrouter.ai/keys) API key (paste it in the extension Settings; no terminal)

Optional: YouTube Data API key (titles/durations), Telegram bot, [Resend](https://resend.com/) for email.

## Setup

```bash
git clone https://github.com/nspage/ingestor.git
cd ingestor
cp .env.example .env
```

### 1. Deploy your worker

```bash
npx wrangler login
cd worker
cp wrangler.toml.example wrangler.toml
npx wrangler kv namespace create YT_PIPELINE
```

Paste the namespace id into `wrangler.toml`. Pick a long random `WORKER_API_SECRET` (same value in `.env` and the worker secret):

```bash
npx wrangler secret put WORKER_API_SECRET
npx wrangler deploy
```

Set in `.env`:

- `WORKER_BASE_URL` — the URL Wrangler prints
- `WORKER_API_SECRET` — the same secret
- `PUBSUB_CALLBACK_URL` — `WORKER_BASE_URL` + `/youtube/pubsub`

Open the side panel → Settings and paste your OpenRouter key (saved on this Mac as `~/.ingestor/secrets.env`). You can still put `OPENROUTER_API_KEY` in `.env` instead.

### 2. Helper + extension

From the repo root:

```bash
npm install
npm run helper:install
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `chrome-extension/`.

Do **not** delete the `"key"` field in `manifest.json`. It pins the extension id so the Start helper button can launch the native host.

Open the side panel and click **Start helper** once so the panel can store your worker URL and token. After that you can browse the queue with the helper off.

**Process** still needs the helper (transcripts are local). **Gemini** on a pending card opens Gemini Web with a prefill; the extension can import that thread as a note (separate from the API key).

### Restart the helper

The Start button does nothing if something is already on port 3000. After a `git pull` or code change:

```bash
npm run helper:restart
```

Logs: `~/Library/Logs/yt-pipeline.log`.

## Daily use

1. Track channels from the Channels tab (or pick videos on YouTube).
2. New publishes show up in Pending.
3. Process, open in Gemini Web, or discard.
4. Notes live in History.

You do not need Docker. Do not deploy the helper to a cloud runner — YouTube will block those IPs.

## Security

Worker API routes expect `Authorization: Bearer $WORKER_API_SECRET`. Never commit `.env` or `worker/wrangler.toml`. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Nicolas S. Page. Not affiliated with YouTube, Google, or Cloudflare.
