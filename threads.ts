/**
 * pi-threads: Thread lifecycle management
 * - Stable session dirs per thread name
 * - TTL-based auto-cleanup
 * - Thread listing and metadata
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThreadInfo } from "./types.js";
import { readEpisodeStore } from "./episodes.js";

const GLOBAL_THREADS_BASE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "sessions",
  "pi-threads-global",
  "threads",
);

// ─── Directory resolution ─────────────────────────────────────────────────────

/**
 * Get the base threads directory for the current parent session.
 * Co-locates thread dirs alongside the parent session file.
 */
export function getThreadsBaseDir(parentSessionFile: string | null): string {
  if (parentSessionFile) {
    const baseName = path.basename(parentSessionFile, ".jsonl");
    const sessionsDir = path.dirname(parentSessionFile);
    return path.join(sessionsDir, baseName, "threads");
  }
  return GLOBAL_THREADS_BASE;
}

/**
 * Get the stable session directory for a named thread.
 * This is the directory passed as --session-dir to the pi subprocess.
 * Consistent across calls → pi resumes the same session.
 */
export function getThreadDir(parentSessionFile: string | null, threadName: string): string {
  const base = getThreadsBaseDir(parentSessionFile);
  // Sanitize name to a safe directory name
  const safe = threadName.replace(/[^\w.-]/g, "_").slice(0, 64);
  return path.join(base, safe);
}

export function ensureThreadDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Thread listing ───────────────────────────────────────────────────────────

export function listThreads(parentSessionFile: string | null): ThreadInfo[] {
  const base = getThreadsBaseDir(parentSessionFile);
  if (!fs.existsSync(base)) return [];

  const threads: ThreadInfo[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const threadDir = path.join(base, entry.name);
    const store = readEpisodeStore(threadDir);
    if (!store) continue;
    threads.push({
      name: store.threadName,
      agentName: store.agentName,
      created: store.created,
      lastActivity: store.lastActivity,
      episodeCount: store.episodes.length,
      sessionDir: threadDir,
    });
  }

  return threads.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

// ─── TTL cleanup ──────────────────────────────────────────────────────────────

export function cleanupExpiredThreads(
  parentSessionFile: string | null,
  ttlDays: number,
): void {
  const base = getThreadsBaseDir(parentSessionFile);
  if (!fs.existsSync(base)) return;

  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const threadDir = path.join(base, entry.name);
    const store = readEpisodeStore(threadDir);
    if (!store) continue;

    const lastActivity = new Date(store.lastActivity).getTime();
    if (lastActivity < cutoff) {
      try {
        fs.rmSync(threadDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

// ─── Destroy ─────────────────────────────────────────────────────────────────

export function destroyThread(
  parentSessionFile: string | null,
  threadName: string,
): { destroyed: boolean; episodeCount: number } {
  const dir = getThreadDir(parentSessionFile, threadName);
  if (!fs.existsSync(dir)) return { destroyed: false, episodeCount: 0 };

  const store = readEpisodeStore(dir);
  const episodeCount = store?.episodes.length ?? 0;

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { destroyed: true, episodeCount };
  } catch {
    return { destroyed: false, episodeCount };
  }
}
