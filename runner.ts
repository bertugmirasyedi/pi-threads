/**
 * pi-threads: Subprocess runner
 * Handles spawning pi processes for thread actions.
 * Key difference from pi-subagents: named threads use --session-dir
 * WITHOUT --no-session, so pi resumes the prior session.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, RunOptions, RunResult } from "./types.js";
import {
  getFinalOutput,
  getPiSpawnCommand,
  applyThinkingSuffix,
  writePromptFile,
  cleanupDir,
  getThreadDepthEnv,
  findLatestSessionFile,
} from "./utils.js";

const TASK_ARG_LIMIT = 8000;

// ─── Core runner ──────────────────────────────────────────────────────────────

export async function runThreadAction(
  runtimeCwd: string,
  agent: AgentConfig,
  task: string,
  options: RunOptions,
): Promise<RunResult> {
  const { cwd, signal, sessionDir, ephemeral, seedFile, modelOverride, onUpdate } = options;

  const args = ["--mode", "json", "-p"];

  // Session persistence: named threads resume; ephemerals start fresh
  if (ephemeral || !sessionDir) {
    args.push("--no-session");
  } else {
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch {}
    // Resume the existing session file if one exists; otherwise create a new
    // session in the thread dir. This is the key to thread persistence:
    // --continue --session <file> resumes AND appends to the same file.
    // --session-dir creates a new file in the thread dir on first use.
    const existingSession = findLatestSessionFile(sessionDir);
    if (existingSession) {
      args.push("--continue", "--session", existingSession);
    } else {
      args.push("--session-dir", sessionDir);
    }
  }

  // Model: override > agent config (with thinking suffix)
  const effectiveModel = modelOverride ?? agent.model;
  const modelArg = applyThinkingSuffix(effectiveModel, agent.thinking);
  // Use --models (not --model): resolves provider automatically
  if (modelArg) args.push("--models", modelArg);

  // Tools
  const builtinTools: string[] = [];
  const toolExtPaths: string[] = [];
  if (agent.tools?.length) {
    for (const t of agent.tools) {
      if (t.includes("/") || t.endsWith(".ts") || t.endsWith(".js")) {
        toolExtPaths.push(t);
      } else {
        builtinTools.push(t);
      }
    }
    if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
  }

  // Extensions
  if (agent.extensions !== undefined) {
    args.push("--no-extensions");
    for (const ext of agent.extensions) args.push("--extension", ext);
  } else {
    for (const ext of toolExtPaths) args.push("--extension", ext);
  }

  // Skills
  if (agent.skills && agent.skills.length > 0) {
    args.push("--no-skills");
    // Skills are injected via system prompt below
  }

  // System prompt: agent body + optional seed episodes
  const systemParts: string[] = [];
  if (agent.systemPrompt.trim()) systemParts.push(agent.systemPrompt.trim());

  // Seed episodes injected via --append-system-prompt temp file
  // (seedFile is written by the caller before invoking this function)
  let tmpDir: string | null = null;
  const cleanupPaths: string[] = [];

  if (systemParts.length > 0 || seedFile) {
    const sysContent = systemParts.join("\n\n");
    if (sysContent) {
      const tmp = writePromptFile(agent.name, sysContent);
      tmpDir = tmp.dir;
      cleanupPaths.push(tmp.dir);
      args.push("--append-system-prompt", tmp.filePath);
    }
  }

  if (seedFile) {
    args.push("--append-system-prompt", seedFile);
  }

  // Task: write to file if too long
  if (task.length > TASK_ARG_LIMIT) {
    if (!tmpDir) {
      const tmp = writePromptFile("task", task);
      tmpDir = tmp.dir;
      cleanupPaths.push(tmp.dir);
      args.push(`@${tmp.filePath}`);
    } else {
      const taskFile = path.join(tmpDir, "task.md");
      fs.writeFileSync(taskFile, `Task: ${task}`, { mode: 0o600 });
      args.push(`@${taskFile}`);
    }
  } else {
    args.push(`Task: ${task}`);
  }

  const result: RunResult = {
    messages: [],
    exitCode: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };

  const startTime = Date.now();
  void startTime; // used to compute turn duration in future

  try {
    const spawnSpec = getPiSpawnCommand(args);
    const spawnEnv = { ...process.env, ...getThreadDepthEnv() };

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: cwd ?? runtimeCwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buf = "";
      let stderrBuf = "";
      let lastUpdateMs = 0;
      const UPDATE_THROTTLE = 60;
      const TAIL_LINES = 16;
      const tailLines: string[] = [];
      let currentTool = "";

      const appendToTail = (text: string) => {
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        tailLines.push(...lines);
        if (tailLines.length > TAIL_LINES) tailLines.splice(0, tailLines.length - TAIL_LINES);
      };

      const scheduleUpdate = () => {
        if (!onUpdate) return;
        const now = Date.now();
        if (now - lastUpdateMs >= UPDATE_THROTTLE) {
          lastUpdateMs = now;
          onUpdate({
            content: [{ type: "text", text: getFinalOutput(result.messages) || "(running…)" }],
            details: {
              mode: "thread" as const,
              results: [],
              running: true,
              outputTail: [...tailLines],
              currentTool,
            } as any,
          });
        }
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            message?: any;
            name?: string;
            tool?: string;
            toolCallId?: string;
          };

          // Track tool calls as they start — gives live activity feedback
          if (evt.type === "tool_execution_start" || evt.type === "tool_call") {
            const toolName = (evt as any).toolName ?? evt.name ?? (evt as any).tool ?? "tool";
            currentTool = toolName;
            appendToTail(`→ ${toolName}`);
            scheduleUpdate();
          }

          // Track tool results for richer context
          if (evt.type === "tool_result_end" || evt.type === "tool_execution_end") {
            if (evt.message) {
              result.messages.push(evt.message);
            }
            currentTool = "";
            scheduleUpdate();
          }

          if (evt.type === "message_end" && evt.message) {
            result.messages.push(evt.message);
            if (evt.message.role === "assistant") {
              result.usage.turns++;
              const u = evt.message.usage;
              if (u) {
                result.usage.input += u.input ?? 0;
                result.usage.output += u.output ?? 0;
                result.usage.cacheRead += u.cacheRead ?? 0;
                result.usage.cacheWrite += u.cacheWrite ?? 0;
                result.usage.cost += u.cost?.total ?? 0;
              }
              if (!result.model && evt.message.model) result.model = evt.message.model;
              if (evt.message.errorMessage) result.error = evt.message.errorMessage;
              // Capture tool call names from assistant content for activity log
              for (const part of evt.message.content ?? []) {
                if (part?.type === "text" && part.text) {
                  appendToTail(part.text);
                } else if (part?.type === "toolCall" || part?.type === "tool_use") {
                  const name = part.name ?? "tool";
                  const args = part.arguments ?? part.input ?? {};
                  // Build a concise activity line from tool name + key arg
                  let detail = "";
                  if (name === "read" && args.path) detail = ` ${args.path}`;
                  else if (name === "bash" && args.command) detail = ` ${String(args.command).slice(0, 60)}`;
                  else if (name === "edit" && args.path) detail = ` ${args.path}`;
                  else if (name === "write" && args.path) detail = ` ${args.path}`;
                  else if (name === "grep" && args.pattern) detail = ` "${args.pattern}"`;
                  else if (name === "find" && args.pattern) detail = ` ${args.pattern}`;
                  else if (name === "lsp" && args.action) detail = ` ${args.action}${args.file ? " " + args.file : ""}`;
                  else if (name === "thread" && args.name) detail = ` ${args.name}`;
                  appendToTail(`→ ${name}${detail}`);
                }
              }
              scheduleUpdate();
            }
          }
        } catch {}
      };

      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(processLine);
        scheduleUpdate();
      });

      proc.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
      });

      proc.on("close", (code) => {
        if (buf.trim()) processLine(buf);
        if (code !== 0 && stderrBuf.trim() && !result.error) {
          result.error = stderrBuf.trim().slice(0, 500);
        }
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
  } finally {
    for (const dir of cleanupPaths) cleanupDir(dir);
  }

  return result;
}

// ─── Seed file builder ────────────────────────────────────────────────────────

export function buildSeedFileContent(seedSections: string[]): string {
  if (seedSections.length === 0) return "";
  return [
    "# Seeded Thread Episodes",
    "The following episodes from other threads provide context for your work:",
    "",
    ...seedSections,
  ].join("\n");
}

export function writeSeedFile(content: string): { dir: string; filePath: string } | null {
  if (!content.trim()) return null;
  return writePromptFile("seed-episodes", content);
}
