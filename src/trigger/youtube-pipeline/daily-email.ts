import "dotenv/config";
import { schedules } from "@trigger.dev/sdk/v3";
import { marked } from "marked";
import { EMAIL_TO, TIMEZONE } from "./config";
import { getTodaysAnalyses } from "./kv-client";
import { sendEmail } from "../utils";

/**
 * Daily Email Digest
 *
 * Runs at 21:00 in TIMEZONE (see .env).
 */
export const dailyEmailDigest = schedules.task({
  id: "yt-daily-email-digest",
  cron: {
    pattern: "0 21 * * *",
    timezone: TIMEZONE,
  },
  run: async () => {
    console.log("Building daily email digest...");

    const analyses = await getTodaysAnalyses();

    if (analyses.length === 0) {
      console.log("No analyses today. Skipping email.");
      return { action: "skipped", reason: "no_analyses" };
    }

    console.log(`${analyses.length} analysis/analyses to send.`);

    // Build email HTML
    const dateStr = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    let html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 750px; margin: 0 auto; background: #0d1117; color: #c9d1d9; padding: 30px;">
        <h1 style="color: #58a6ff; text-align: center; font-size: 28px; margin-bottom: 5px;">📊 Daily YouTube Analysis</h1>
        <p style="text-align: center; color: #8b949e; font-size: 14px; margin-bottom: 30px;">${dateStr} — ${analyses.length} video(s) analyzed</p>
    `;

    const categoryColors: Record<string, string> = {
      growth: "#3fb950",
      "ai concepts": "#58a6ff",
      entrepreneurship: "#d29922",
      "web3 business": "#bc8cff",
    };

    for (const entry of analyses) {
      const catColor = categoryColors[entry.category] || "#8b949e";

      // Convert analysis markdown to HTML
      let analysisHtml: string;
      try {
        analysisHtml = await marked.parse(entry.analysis);
      } catch {
        analysisHtml = `<pre>${entry.analysis}</pre>`;
      }

      html += `
        <div style="margin-bottom: 30px; border: 1px solid #30363d; border-radius: 8px; overflow: hidden;">
          <div style="background: #161b22; padding: 15px; border-bottom: 1px solid #30363d;">
            <span style="display: inline-block; background: ${catColor}; color: #0d1117; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px;">${entry.category}</span>
            <h2 style="color: #f0f6fc; margin: 8px 0 4px; font-size: 18px;">
              <a href="${entry.videoUrl}" style="color: #58a6ff; text-decoration: none;">${entry.title}</a>
            </h2>
            <p style="color: #8b949e; font-size: 13px; margin: 0;">📺 ${entry.channelName} • Processed ${new Date(entry.processedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
          <div style="padding: 15px; font-size: 14px; line-height: 1.6;">
            ${analysisHtml}
          </div>
        </div>
      `;

      // Transcript section (collapsible in email clients that support it)
      html += `
        <div style="margin-top: -20px; margin-bottom: 30px; border: 1px solid #21262d; border-radius: 8px; overflow: hidden;">
          <details>
            <summary style="background: #161b22; padding: 10px 15px; cursor: pointer; color: #8b949e; font-size: 13px;">
              📄 Raw Transcript — ${entry.title} (${entry.transcript.length.toLocaleString()} chars)
            </summary>
            <div style="padding: 15px; font-size: 12px; color: #8b949e; line-height: 1.5; max-height: 400px; overflow-y: auto; white-space: pre-wrap;">
              ${entry.transcript.slice(0, 10000)}${entry.transcript.length > 10000 ? "\n\n... [truncated]" : ""}
            </div>
          </details>
        </div>
      `;
    }

    html += `
        <footer style="margin-top: 40px; text-align: center; color: #484f58; font-size: 12px; padding-top: 20px; border-top: 1px solid #21262d;">
          YouTube LLM Pipeline • ${analyses.length} video(s) • ${dateStr}
        </footer>
      </div>
    `;

    if (!EMAIL_TO) {
      console.log("EMAIL_TO missing. Skipping email.");
      return { action: "skipped", reason: "no_email" };
    }

    const emailResult = await sendEmail({
      to: EMAIL_TO,
      subject: `📊 YouTube Analysis Digest — ${dateStr} (${analyses.length} videos)`,
      html,
    });

    if (!emailResult.ok) {
      throw new Error(`Email failed: ${emailResult.error}`);
    }

    console.log("Daily digest sent successfully.");
    return { action: "sent", videoCount: analyses.length };
  },
});
