/**
 * ⚠️ LOCAL-FIRST EXECUTION ONLY
 * This project is designed to run in a local Docker container to bypass YouTube IP blocks.
 * DO NOT deploy this project to Trigger.dev Cloud.
 */
import type { TriggerConfig } from "@trigger.dev/sdk/v3";
import "dotenv/config";

export const config: TriggerConfig = {
    project: process.env.TRIGGER_PROJECT_ID ?? "local_yt_pipeline",
    maxDuration: 300, // 5 minutes
    logLevel: "log",
    retries: {
        enabledInDev: true,
        default: {
            maxAttempts: 3,
            minTimeoutInMs: 1000,
            maxTimeoutInMs: 10000,
            factor: 2,
            randomize: true,
        },
    },
};
