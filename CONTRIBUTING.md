# Contributing

Issues and pull requests are welcome on [github.com/nspage/ingestor](https://github.com/nspage/ingestor).

## How to test a change

1. Copy `.env.example` to `.env` and point `WORKER_BASE_URL` at **your** worker.
2. `npm install` and `npm run helper:install`.
3. Chrome → `chrome://extensions` → Load unpacked → `chrome-extension/`.
4. Start the helper from the side panel once, then exercise the flow you changed (queue, process, Gemini import, or channels).

Do not commit `.env`, `worker/wrangler.toml`, or live channel/queue dumps.
