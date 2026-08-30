import fs from "fs";
import os from "os";
import path from "path";

const KNOWN = ["OPENROUTER_API_KEY", "GOOGLE_API_KEY"] as const;
export type SecretName = (typeof KNOWN)[number];

export function secretsPath(): string {
  return path.join(os.homedir(), ".ingestor", "secrets.env");
}

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Overlay ~/.ingestor/secrets.env on process.env so Settings wins over project .env. */
export function loadUserSecrets(): void {
  const file = secretsPath();
  if (!fs.existsSync(file)) return;
  try {
    const parsed = parseEnvFile(fs.readFileSync(file, "utf8"));
    for (const key of KNOWN) {
      if (parsed[key]) process.env[key] = parsed[key];
    }
  } catch {
    /* keep existing env */
  }
}

export function saveUserSecrets(patch: Partial<Record<SecretName, string>>): void {
  const file = secretsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, "utf8")) : {};
  for (const key of KNOWN) {
    const next = patch[key];
    if (typeof next === "string" && next.trim()) current[key] = next.trim();
  }
  const body =
    KNOWN.filter((key) => current[key])
      .map((key) => `${key}=${current[key]}`)
      .join("\n") + "\n";
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows no-op */
  }
  for (const key of KNOWN) {
    if (current[key]) process.env[key] = current[key];
  }
}

export function secretsStatus(): {
  openrouter: boolean;
  gemini: boolean;
  youtube: boolean;
  llm: boolean;
} {
  const openrouter = !!process.env.OPENROUTER_API_KEY;
  const gemini = !!process.env.GEMINI_API_KEY;
  return {
    openrouter,
    gemini,
    youtube: !!process.env.GOOGLE_API_KEY,
    llm: openrouter || gemini,
  };
}
