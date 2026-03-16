/**
 * pi-threads: Subprocess utilities
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DisplayItem } from "./types.js";

const _require = createRequire(import.meta.url);

// ─── pi spawn resolution (macOS/Linux/Windows) ────────────────────────────────

export interface PiSpawnCommand {
  command: string;
  args: string[];
}

function resolvePiPackageRoot(): string | undefined {
  try {
    const entry = process.argv[1];
    if (!entry) return undefined;
    let dir = path.dirname(fs.realpathSync(entry));
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
          name?: string;
        };
        if (pkg.name === "@mariozechner/pi-coding-agent") return dir;
      } catch {}
      dir = path.dirname(dir);
    }
  } catch {}
  return undefined;
}

function resolveWindowsPiCliScript(): string | undefined {
  try {
    const argv1 = process.argv[1];
    if (argv1) {
      const p = path.isAbsolute(argv1) ? argv1 : path.resolve(argv1);
      if (fs.existsSync(p) && /\.(?:mjs|cjs|js)$/i.test(p)) return p;
    }
    const root = resolvePiPackageRoot();
    const pkgPath = root
      ? path.join(root, "package.json")
      : _require.resolve("@mariozechner/pi-coding-agent/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = pkg.bin;
    const binPath =
      typeof bin === "string" ? bin : bin?.pi ?? Object.values(bin ?? {})[0];
    if (!binPath) return undefined;
    const candidate = path.resolve(path.dirname(pkgPath), binPath);
    if (fs.existsSync(candidate) && /\.(?:mjs|cjs|js)$/i.test(candidate)) return candidate;
  } catch {}
  return undefined;
}

export function getPiSpawnCommand(args: string[]): PiSpawnCommand {
  if (process.platform === "win32") {
    const script = resolveWindowsPiCliScript();
    if (script) return { command: process.execPath, args: [script, ...args] };
  }
  return { command: "pi", args };
}

// ─── Message utilities ────────────────────────────────────────────────────────

export function getFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function getDisplayItems(messages: any[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "tool", name: part.name, args: part.arguments as Record<string, unknown> });
      }
    }
  }
  return items;
}

export function extractTextFromContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      if ("type" in part && part.type === "text" && "text" in part) parts.push(String(part.text));
      else if ("text" in part) parts.push(String(part.text));
    }
  }
  return parts.join("\n");
}

// ─── Filesystem utilities ─────────────────────────────────────────────────────

export function findLatestSessionFile(sessionDir: string): string | null {
  if (!fs.existsSync(sessionDir)) return null;
  const files = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(sessionDir, f);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}

export function writePromptFile(name: string, content: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-"));
  const safe = name.replace(/[^\w.-]/g, "_");
  const filePath = path.join(dir, `${safe}.md`);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return { dir, filePath };
}

export function cleanupDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ─── Concurrency ──────────────────────────────────────────────────────────────

export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(safeLimit, items.length) }, worker),
  );
  return results;
}

// ─── Thinking suffix ──────────────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function applyThinkingSuffix(
  model: string | undefined,
  thinking: string | undefined,
): string | undefined {
  if (!model || !thinking || thinking === "off") return model;
  const idx = model.lastIndexOf(":");
  if (idx !== -1 && THINKING_LEVELS.includes(model.substring(idx + 1))) return model;
  return `${model}:${thinking}`;
}

// ─── Depth guard (prevent runaway nested threads) ─────────────────────────────

const DEPTH_ENV = "PI_THREADS_DEPTH";
const MAX_DEPTH = 3;

export function getThreadDepth(): number {
  return parseInt(process.env[DEPTH_ENV] ?? "0", 10);
}

export function getThreadDepthEnv(): Record<string, string> {
  const current = getThreadDepth();
  return { [DEPTH_ENV]: String(current + 1) };
}

export function isThreadDepthBlocked(): boolean {
  return getThreadDepth() >= MAX_DEPTH;
}
