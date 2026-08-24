# Operator guide

This is what runs after the [README](../README.md) setup. Your queue lives in **your** Cloudflare KV, not in this git repo.

## Pieces

1. **YouTube PubSubHubbub** notifies your worker when a tracked channel publishes.
2. **Worker + KV** store pending videos, channels, categories, and notes.
3. **Chrome extension** is the dashboard (Pending, Channels, History).
4. **Local helper** (`npm run helper:install`) fetches transcripts and calls Gemini when you click Process.
5. **Optional delivery:** Telegram checkbox in the panel; nightly digest if `EMAIL_TO` and `RESEND_API_KEY` are set (`TIMEZONE` in `.env`, default UTC, cron 21:00).

## Secrets

Set worker secrets in the Cloudflare dashboard or with `npx wrangler secret put`:

- `WORKER_API_SECRET` (required)
- `GOOGLE_API_KEY` (optional, YouTube metadata)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (optional)

Local `.env` must use the same `WORKER_API_SECRET`. Keep `worker/wrangler.toml` on your machine only (copy from `wrangler.toml.example`).

## PubSub leases

YouTube leases expire. Re-subscribe from the Channels tab or by re-adding the channel if new videos stop arriving. Default lease is five days.

## Prompts

Category prompts are stored in KV. Edit them in the extension Categories UI, or change worker defaults in `worker/src/index.ts`.

## Helper logs

macOS: `~/Library/Logs/yt-pipeline.log`

## Docker

`Dockerfile` / `docker-compose.yml` are leftovers from an older runner. The supported path is the native helper, not Docker.
