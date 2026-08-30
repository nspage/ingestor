# Contributing

Issues and pull requests are welcome on [github.com/nspage/ingestor](https://github.com/nspage/ingestor).

## How to test a change

1. Copy `.env.example` to `.env` and point `WORKER_BASE_URL` at **your** worker. Use **your** OpenRouter (or Gemini) key.
2. `npm install` and `npm run helper:install`.
3. Chrome → `chrome://extensions` → Load unpacked → `chrome-extension/`.
4. `npm run helper:restart` (or Start helper if nothing is on :3000), then exercise the flow you changed (queue, process, Gemini import, or channels).
5. macOS only for the native host. Do not delete `manifest.json` `"key"`.

Do not commit `.env`, `worker/wrangler.toml`, or live channel/queue dumps.
