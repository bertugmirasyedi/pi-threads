/**
 * pi-threads: Episode store
 *
 * Reads/writes episodes.json per thread directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Episode, ThreadEpisodeStore, FileRef } from "./types.js";

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
