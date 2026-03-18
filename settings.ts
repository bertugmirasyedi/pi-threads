/**
 * pi-threads: Configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
  /** Model used for episode extraction. Should be cheap (Haiku/Flash). */
  episodeModel: string;
  /** Days before an inactive thread is auto-deleted. */
  threadTTLDays: number;
  /** Default agent when none specified. */
  defaultAgent: string;
  /** Max tasks in parallel mode. */
  maxParallel: number;
  /** Max concurrent parallel tasks. */
  maxConcurrency: number;
}

export const DEFAULT_CONFIG: Config = {
  episodeModel: "",
  threadTTLDays: 7,
  defaultAgent: "worker",
  maxParallel: 8,
  maxConcurrency: 4,
};

const CONFIG_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
  "pi-threads",
  "config.json",
);

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch {
    // ignore — use defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<Config>): void {
  try {
    const existing = loadConfig();
    const merged = { ...existing, ...config };
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // ignore
  }
}
