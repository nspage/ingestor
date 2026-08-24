# Security

This project is meant to run against **your** Cloudflare worker, **your** Gemini key, and a helper on **your** machine. Do not file secrets, `.env` contents, worker tokens, or Telegram chat IDs in GitHub issues.

## If something leaked

1. Rotate the affected key in the dashboard that issued it (Google, Gemini, Cloudflare, Telegram, Resend, Trigger.dev).
2. `npx wrangler secret put WORKER_API_SECRET` on the worker, and update local `.env` to match.
3. Treat `TELEGRAM_CHAT_ID` as personal data, not just a config value.

## Reporting a vulnerability

Use [GitHub security advisories](https://github.com/nspage/ingestor/security/advisories) on this repository. Do not open a public issue for a secret or an auth bypass.
