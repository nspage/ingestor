# Security

This project is meant to run against **your** Cloudflare worker, **your** OpenRouter or Gemini key, and a helper on **your** machine. The author does not proxy inference or store other people’s queues. Do not file secrets, `.env` contents, `~/.ingestor/secrets.env`, worker tokens, or Telegram chat IDs in GitHub issues.

The OpenRouter key belongs on the helper (extension Settings writes `~/.ingestor/secrets.env`, chmod 600). Do not put it on the Cloudflare Worker.

## If something leaked

1. Rotate the affected key where it was issued (OpenRouter, Google AI Studio, YouTube Data API, Cloudflare, Telegram).
2. `npx wrangler secret put WORKER_API_SECRET` on the worker, and update local `.env` to match.
3. Treat `TELEGRAM_CHAT_ID` as personal data, not just a config value.

## Reporting a vulnerability

Use [GitHub security advisories](https://github.com/nspage/ingestor/security/advisories) on this repository. Do not open a public issue for a secret or an auth bypass.
