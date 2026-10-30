import "dotenv/config";
import { readFileSync } from "node:fs";
import { runServer } from "./server.js";
import type { ServerConfig } from "./server.js";
import { error as logError } from "./logging.js";

function readConfig(): ServerConfig {
  let stored: Record<string, unknown> = {};
  const credentialsFile = process.env.KAGI_CREDENTIALS_FILE;
  if (credentialsFile) {
    try {
      const data = JSON.parse(readFileSync(credentialsFile, "utf8"));
      if (!data.env || typeof data.env !== "object" || Array.isArray(data.env)) throw new Error();
      stored = data.env;
    } catch {
      throw new Error("Cannot read the env object in KAGI_CREDENTIALS_FILE");
    }
  }
  const value = (key: string): string | undefined => {
    const candidate = process.env[key] || stored[key];
    return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
  };
  const authorization = value("KAGI_TRANSLATE_AUTHORIZATION");
  if (authorization) {
    const token = value("KAGI_TRANSLATE_SESSION_TOKEN");
    return { session: { authorization, ...(token ? { token } : {}) } };
  }
  const apiKey = value("KAGI_API_KEY");
  if (!apiKey) throw new Error("KAGI_TRANSLATE_AUTHORIZATION or KAGI_API_KEY is required");
  return { apiKey };
}

async function main(): Promise<void> {
  try {
    await runServer(readConfig());
  } catch (err) {
    logError("Failed to start Kagi Translate MCP server", { error: String(err) });
    process.exitCode = 1;
  }
}

void main();
