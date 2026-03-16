/**
 * pi-threads: Episode store and extractor
 *
 * Episode store: reads/writes episodes.json per thread directory.
 * Episode extractor: spawns a cheap-model pi subprocess to compress
 *   raw agent output into a structured Episode object.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Episode, ThreadEpisodeStore } from "./types.js";
import type { Config } from "./settings.js";
import { getFinalOutput, getPiSpawnCommand, writePromptFile, cleanupDir, getThreadDepthEnv } from "./utils.js";

const EPISODES_FILE = "episodes.json";

// ─── Episode store ────────────────────────────────────────────────────────────

export function readEpisodeStore(threadDir: string): ThreadEpisodeStore | null {
  const p = path.join(threadDir, EPISODES_FILE);
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ThreadEpisodeStore;
  } catch {
    return null;
  }
}

export function writeEpisodeStore(threadDir: string, store: ThreadEpisodeStore): void {
  fs.mkdirSync(threadDir, { recursive: true });
  fs.writeFileSync(path.join(threadDir, EPISODES_FILE), JSON.stringify(store, null, 2), "utf-8");
}

export function appendEpisode(
  threadDir: string,
  threadName: string,
  agentName: string | undefined,
  episode: Episode,
): void {
  const existing = readEpisodeStore(threadDir);
  const now = new Date().toISOString();
  const store: ThreadEpisodeStore = existing ?? {
    threadName,
    agentName,
    created: now,
    lastActivity: now,
    episodes: [],
  };
  store.lastActivity = now;
  if (agentName && !store.agentName) store.agentName = agentName;
  store.episodes.push(episode);
  writeEpisodeStore(threadDir, store);
}

export function formatEpisodesForSeed(store: ThreadEpisodeStore): string {
  if (store.episodes.length === 0) return "";
  const lines: string[] = [
    `## Thread Episodes: ${store.threadName}`,
    `Agent: ${store.agentName ?? "default"} | ${store.episodes.length} episode(s)`,
    "",
  ];
  for (const ep of store.episodes) {
    lines.push(`### Episode ${ep.id}: ${ep.objective}`);
    if (ep.key_findings.length > 0) {
      lines.push("**Key Findings:**");
      for (const f of ep.key_findings) lines.push(`- ${f}`);
    }
    lines.push(`**Conclusions:** ${ep.conclusions}`);
    if (ep.files_read.length > 0) lines.push(`**Files Read:** ${ep.files_read.join(", ")}`);
    if (ep.files_modified.length > 0) lines.push(`**Files Modified:** ${ep.files_modified.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatEpisodeAsContent(
  ep: Episode,
  threadName?: string,
): string {
  const header = threadName
    ? `## Thread "${threadName}" — Episode ${ep.id}`
    : `## Episode ${ep.id}`;
  const lines = [header, `**Objective:** ${ep.objective}`, ""];
  if (ep.key_findings.length > 0) {
    lines.push("**Key Findings:**");
    for (const f of ep.key_findings) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push(`**Conclusions:** ${ep.conclusions}`);
  if (ep.files_read.length > 0) lines.push(`\n**Files Read:** ${ep.files_read.join(", ")}`);
  if (ep.files_modified.length > 0) lines.push(`**Files Modified:** ${ep.files_modified.join(", ")}`);
  return lines.join("\n");
}

// ─── Episode extractor ────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT =
  "You are a JSON extractor. Always respond with ONLY valid JSON. No markdown, no code fences, no explanation.";

function buildExtractionPrompt(task: string, rawOutput: string): string {
  const truncatedOutput = rawOutput.slice(0, 6000);
  return `Extract a structured episode from this agent work session.

Task performed:
${task.slice(0, 600)}

Agent output:
${truncatedOutput}

Return ONLY this JSON object (no markdown, no code fences):
{
  "objective": "one clear sentence describing what was accomplished",
  "key_findings": ["specific concrete finding 1", "specific concrete finding 2"],
  "conclusions": "2-3 sentences summarizing what was learned and its strategic implications",
  "files_read": ["path/to/file.ts"],
  "files_modified": ["path/to/changed.ts"]
}`;
}

async function spawnEpisodeExtractor(
  prompt: string,
  config: Config,
  cwd: string,
): Promise<any[]> {
  let tmpDir: string | null = null;
  try {
    const systemTmp = writePromptFile("ep-system", EXTRACTION_SYSTEM_PROMPT);
    tmpDir = systemTmp.dir;
    const taskFile = path.join(tmpDir, "task.md");
    fs.writeFileSync(taskFile, prompt, { mode: 0o600 });

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--models", config.episodeModel,
      "--append-system-prompt", systemTmp.filePath,
      `@${taskFile}`,
    ];

    const messages: any[] = [];
    const spawnSpec = getPiSpawnCommand(args);

    await new Promise<void>((resolve) => {
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        env: { ...process.env, ...getThreadDepthEnv() },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buf = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const evt = JSON.parse(line) as { type?: string; message?: any };
          if (evt.type === "message_end" && evt.message) messages.push(evt.message);
        } catch {}
      };

      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(processLine);
      });
      proc.on("close", () => {
        if (buf.trim()) processLine(buf);
        resolve();
      });
      proc.on("error", () => resolve());
    });

    return messages;
  } finally {
    cleanupDir(tmpDir);
  }
}

function parseEpisodeJson(raw: string): Omit<Episode, "id" | "timestamp"> | null {
  // Strip markdown code fences if the model ignored instructions
  const cleaned = raw
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim();

  // Find the first { ... } block
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    return {
      objective: String(parsed.objective ?? ""),
      key_findings: Array.isArray(parsed.key_findings)
        ? parsed.key_findings.map(String)
        : [],
      conclusions: String(parsed.conclusions ?? ""),
      files_read: Array.isArray(parsed.files_read) ? parsed.files_read.map(String) : [],
      files_modified: Array.isArray(parsed.files_modified) ? parsed.files_modified.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Extract a structured episode from task + raw output.
 * Falls back to a minimal episode if extraction fails.
 */
export async function extractEpisode(
  task: string,
  rawOutput: string,
  nextId: number,
  config: Config,
  cwd: string,
): Promise<Episode> {
  const timestamp = new Date().toISOString();

  try {
    const prompt = buildExtractionPrompt(task, rawOutput);
    const messages = await spawnEpisodeExtractor(prompt, config, cwd);
    const outputText = getFinalOutput(messages);
    const parsed = parseEpisodeJson(outputText);
    if (parsed && parsed.objective) {
      return { id: nextId, timestamp, ...parsed };
    }
  } catch {
    // fall through to fallback
  }

  // Graceful fallback
  return {
    id: nextId,
    timestamp,
    objective: task.slice(0, 120),
    key_findings: [],
    conclusions: rawOutput.slice(0, 400) || "(no output)",
    files_read: [],
    files_modified: [],
  };
}
