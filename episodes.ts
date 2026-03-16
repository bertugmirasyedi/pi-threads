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
import type { Episode, ThreadEpisodeStore, FileRef } from "./types.js";
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
    if (ep.file_refs && ep.file_refs.length > 0) {
      lines.push("**Code References:**");
      for (const ref of ep.file_refs) {
        const loc = ref.line !== undefined ? `${ref.file}:${ref.line}` : ref.file;
        lines.push(`- \`${loc}\` — ${ref.context}`);
      }
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
  if (ep.file_refs && ep.file_refs.length > 0) {
    lines.push("\n**Code References:**");
    for (const ref of ep.file_refs) {
      const loc = ref.line !== undefined ? `${ref.file}:${ref.line}` : ref.file;
      lines.push(`- \`${loc}\` — ${ref.context}`);
    }
  }
  if (ep.files_read.length > 0) lines.push(`\n**Files Read:** ${ep.files_read.join(", ")}`);
  if (ep.files_modified.length > 0) lines.push(`**Files Modified:** ${ep.files_modified.join(", ")}`);
  return lines.join("\n");
}

// ─── Episode extractor ────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT =
  "You are a JSON extractor. Always respond with ONLY valid JSON. No markdown, no code fences, no explanation.";

function buildExtractionPrompt(task: string, rawOutput: string): string {
  const truncatedOutput = rawOutput.slice(0, 12000);
  const wasTruncated = rawOutput.length > 12000;
  return `Extract a complete structured episode from this agent work session.

Task performed:
${task.slice(0, 800)}

Agent output:
${truncatedOutput}${wasTruncated ? `\n\n[Output truncated at 12000 chars — ${rawOutput.length - 12000} chars omitted]` : ""}

Instructions:
- List EVERY finding — security issues, behavior changes, bugs, convention violations, test gaps, missing items. Do NOT filter to "key" findings only.
- For each finding that references a specific location in code, add an entry to file_refs with the file path, line number (if mentioned), and a one-line description of what matters there.
- If the output mentions file:line references (e.g. "auth.py:81", "line 42 of query.py"), extract them into file_refs.

Return ONLY this JSON object (no markdown, no code fences):
{
  "objective": "one clear sentence describing what was accomplished",
  "key_findings": [
    "complete finding including relevant file paths and code patterns",
    "another complete finding — include every security, behavioral, and convention issue found"
  ],
  "conclusions": "2-3 sentences: what was learned, biggest risks, recommended next actions",
  "files_read": ["path/to/file.ts"],
  "files_modified": ["path/to/changed.ts"],
  "file_refs": [
    {"file": "path/to/file.ts", "line": 42, "context": "one-line description of why this location matters"},
    {"file": "path/to/other.ts", "context": "description when no specific line is known"}
  ]
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

    // Parse file_refs — each entry must have at least {file, context}
    const rawRefs = Array.isArray(parsed.file_refs) ? parsed.file_refs : [];
    const file_refs: FileRef[] = rawRefs
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map((r) => ({
        file: String(r.file ?? ""),
        ...(r.line !== undefined && r.line !== null ? { line: Number(r.line) } : {}),
        context: String(r.context ?? ""),
      }))
      .filter((r) => r.file && r.context);

    return {
      objective: String(parsed.objective ?? ""),
      key_findings: Array.isArray(parsed.key_findings)
        ? parsed.key_findings.map(String)
        : [],
      conclusions: String(parsed.conclusions ?? ""),
      files_read: Array.isArray(parsed.files_read) ? parsed.files_read.map(String) : [],
      files_modified: Array.isArray(parsed.files_modified) ? parsed.files_modified.map(String) : [],
      ...(file_refs.length > 0 ? { file_refs } : {}),
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
