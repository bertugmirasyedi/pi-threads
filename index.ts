/**
 * pi-threads: Extension entry point
 *
 * Registers:
 *   - `thread` tool  — named persistent threads + ephemeral + chain
 *   - `thread_status` tool — inspect a thread's episodes
 *   - /run, /chain, /thread commands
 *   - session_start → TTL cleanup
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { ThreadParams, ThreadStatusParams } from "./schemas.js";
import { loadConfig } from "./settings.js";
import { discoverAgents, findAgent } from "./agents.js";
import { runThreadAction, buildSeedFileContent, writeSeedFile } from "./runner.js";
import {
  appendEpisode,
  readEpisodeStore,
  formatEpisodesForSeed,
  formatEpisodeAsContent,
} from "./episodes.js";
import {
  getThreadDir,
  listThreads,
  cleanupExpiredThreads,
  destroyThread,
} from "./threads.js";
import { renderCall, renderResult } from "./render.js";
import {
  getFinalOutput,
  isThreadDepthBlocked,
  getThreadDepth,
  cleanupDir,
} from "./utils.js";
import type { ToolDetails, ThreadRunResult, Episode } from "./types.js";

// ─── Extension entry ──────────────────────────────────────────────────────────

export default function registerPiThreads(pi: ExtensionAPI): void {
  const config = loadConfig();

  // ── Cleanup expired threads on session start ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    try {
      cleanupExpiredThreads(parentSessionFile, config.threadTTLDays);
    } catch {
      // non-fatal
    }
  });

  // ── thread tool ───────────────────────────────────────────────────────────
  // Only register thread tools at depth 0 (main session).
  // Subprocesses (depth > 0) must NOT have thread access to prevent deep recursion.
  if (getThreadDepth() === 0) {
  pi.registerTool({
    name: "thread",
    label: "Thread",
    description: `Delegate work to persistent worker threads or ephemeral agents. Threads accumulate context across actions — send multiple actions to the same named thread to build knowledge incrementally. Returns structured episodes (not raw output).

MODES:
• Named thread: { name: "backend-auth", task: "...", agent?: "scout" }
  - Persistent: thread resumes all prior context on each action
  - Returns episode: compressed findings + conclusions
  - Seed with other threads: { seed_from: ["other-thread"] }
• Ephemeral: { task: "...", agent: "scout" } — one-shot, no memory
• Chain: { chain: [{ agent: "scout", task: "..." }, { agent: "planner" }] }
• Management: { list: true } | { episodes: "name" } | { destroy: "name" }`,

    promptGuidelines: [
      "Use NAMED THREADS for multi-step workstreams that need context continuity (explore → plan → implement).",
      "Use EPHEMERAL (no name) for one-shot delegation that doesn't need prior context.",
      "Keep thread actions BOUNDED — one clear objective per action.",
      "Name threads by workstream: 'backend-auth', 'test-suite', 'api-design'.",
      "Use seed_from to compose findings across workstreams: { name: 'impl', seed_from: ['explore'] }.",
      "Threads auto-compact via pi's built-in context management.",
      `Threads expire after ${config.threadTTLDays} days of inactivity.`,
    ],

    parameters: ThreadParams,

    async execute(_id, params, signal, onUpdate, ctx) {
      const runtimeCwd = ctx.cwd;
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
      const { agents } = discoverAgents(runtimeCwd, params.agentScope ?? "both");

      // Depth guard
      if (isThreadDepthBlocked()) {
        return {
          content: [
            {
              type: "text",
              text: `Nested thread call blocked (depth=${getThreadDepth()}). Complete your current task directly without delegating further.`,
            },
          ],
          isError: true,
          details: { mode: "ephemeral" } as ToolDetails,
        };
      }

      // ── Management: list ────────────────────────────────────────────────
      if (params.list) {
        const threads = listThreads(parentSessionFile);
        const lines: string[] = [];
        if (threads.length === 0) {
          lines.push("No active threads.");
        } else {
          for (const t of threads) {
            const age = Math.round(
              (Date.now() - new Date(t.lastActivity).getTime()) / 60_000,
            );
            lines.push(
              `• ${t.name}${t.agentName ? ` [${t.agentName}]` : ""} — ${t.episodeCount} episode(s), last active ${age}m ago`,
            );
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { mode: "list", threads } as ToolDetails,
        };
      }

      // ── Management: episodes ────────────────────────────────────────────
      if (params.episodes) {
        const dir = getThreadDir(parentSessionFile, params.episodes);
        const store = readEpisodeStore(dir);
        if (!store || store.episodes.length === 0) {
          return {
            content: [{ type: "text", text: `No episodes found for thread "${params.episodes}".` }],
            details: { mode: "episodes", threadEpisodes: [] } as ToolDetails,
          };
        }
        const formatted = store.episodes
          .map((ep) => formatEpisodeAsContent(ep, params.episodes))
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: formatted }],
          details: { mode: "episodes", threadEpisodes: store.episodes } as ToolDetails,
        };
      }

      // ── Management: destroy ─────────────────────────────────────────────
      if (params.destroy) {
        const { destroyed, episodeCount } = destroyThread(parentSessionFile, params.destroy);
        const msg = destroyed
          ? `Thread "${params.destroy}" destroyed. (${episodeCount} episode(s) removed)`
          : `Thread "${params.destroy}" not found.`;
        return {
          content: [{ type: "text", text: msg }],
          details: { mode: "destroy", destroyedThread: params.destroy } as ToolDetails,
        };
      }

      // ── Execution: chain ────────────────────────────────────────────────
      if (params.chain && params.chain.length > 0) {
        if (!params.chain[0].task && !params.task) {
          return {
            content: [{ type: "text", text: "Chain error: first step must have a task." }],
            isError: true,
            details: { mode: "chain" } as ToolDetails,
          };
        }

        const chainResults: ThreadRunResult[] = [];
        let previousEpisodeText = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const rawTask = step.task ?? (i === 0 ? params.task ?? "" : "{previous}");
          const resolvedTask = rawTask
            .replace(/\{previous\}/g, previousEpisodeText)
            .replace(/\{task\}/g, params.task ?? "");

          const agentName = step.agent ?? params.agent ?? config.defaultAgent;
          const agent = findAgent(agents, agentName, config.defaultAgent);
          if (!agent) {
            return {
              content: [{ type: "text", text: `Chain step ${i + 1}: unknown agent "${agentName}".` }],
              isError: true,
              details: { mode: "chain", results: chainResults } as ToolDetails,
            };
          }

          const stepThreadName = step.name ?? undefined;
          const stepSessionDir = stepThreadName
            ? getThreadDir(parentSessionFile, stepThreadName)
            : undefined;

          const runResult = await runThreadAction(runtimeCwd, agent, resolvedTask, {
            cwd: runtimeCwd,
            signal,
            sessionDir: stepSessionDir,
            ephemeral: !stepThreadName,
            modelOverride: step.model ?? params.model,
            onUpdate: onUpdate
              ? (p) => onUpdate({
                  ...p,
                  details: {
                    ...p.details,
                    mode: "chain",
                    results: chainResults,
                    activityLabel: stepThreadName ?? `step ${i + 1}`,
                  } as ToolDetails,
                })
              : undefined,
          });

          const store = stepThreadName ? readEpisodeStore(stepSessionDir!) : null;
          const nextId = (store?.episodes.length ?? 0) + 1;
          const rawOutput = getFinalOutput(runResult.messages);
          const episode: Episode = {
            id: nextId,
            timestamp: new Date().toISOString(),
            objective: resolvedTask.slice(0, 200),
            key_findings: [],
            conclusions: rawOutput,
            files_read: [],
            files_modified: [],
          };

          if (stepThreadName) {
            appendEpisode(stepSessionDir!, stepThreadName, agent.name, episode);
          }

          const stepResult: ThreadRunResult = {
            threadName: stepThreadName,
            episode,
            runResult,
            seededFrom: [],
          };
          chainResults.push(stepResult);
          previousEpisodeText = rawOutput;

          if (runResult.exitCode !== 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain failed at step ${i + 1} (${agent.name}): ${runResult.error ?? "exit code " + runResult.exitCode}`,
                },
              ],
              isError: true,
              details: { mode: "chain", results: chainResults } as ToolDetails,
            };
          }
        }

        const finalEp = chainResults[chainResults.length - 1].episode;
        const summary = finalEp.conclusions;
        return {
          content: [{ type: "text", text: summary }],
          details: { mode: "chain", results: chainResults } as ToolDetails,
        };
      }

      // ── Execution: single / named thread ────────────────────────────────
      if (!params.task) {
        return {
          content: [
            {
              type: "text",
              text: "Provide one of: task (single/thread), chain, list, episodes, destroy.",
            },
          ],
          isError: true,
          details: { mode: "ephemeral" } as ToolDetails,
        };
      }

      const agentName = params.agent ?? config.defaultAgent;
      const agent = findAgent(agents, agentName, config.defaultAgent);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Unknown agent: "${agentName}". Run { list: true } to see available agents.` }],
          isError: true,
          details: { mode: "ephemeral" } as ToolDetails,
        };
      }

      const isNamed = Boolean(params.name);
      const threadSessionDir = isNamed
        ? getThreadDir(parentSessionFile, params.name!)
        : undefined;

      // Build seed content from other threads
      let seedFileResult: { dir: string; filePath: string } | null = null;
      const seededFrom: string[] = [];
      if (params.seed_from && params.seed_from.length > 0) {
        const seedSections: string[] = [];
        for (const sourceName of params.seed_from) {
          const sourceDir = getThreadDir(parentSessionFile, sourceName);
          const store = readEpisodeStore(sourceDir);
          if (store && store.episodes.length > 0) {
            seedSections.push(formatEpisodesForSeed(store));
            seededFrom.push(sourceName);
          }
        }
        if (seedSections.length > 0) {
          const content = buildSeedFileContent(seedSections);
          seedFileResult = writeSeedFile(content);
        }
      }

      try {
        const runResult = await runThreadAction(runtimeCwd, agent, params.task, {
          cwd: runtimeCwd,
          signal,
          sessionDir: threadSessionDir,
          ephemeral: !isNamed,
          seedFile: seedFileResult?.filePath,
          modelOverride: params.model,
          onUpdate: onUpdate
            ? (p) => onUpdate({
                ...p,
                details: {
                  ...p.details,
                  mode: isNamed ? "thread" : "ephemeral",
                  activityLabel: params.name ?? "ephemeral",
                } as ToolDetails,
              })
            : undefined,
        });

        // Extract episode
        const store = isNamed ? readEpisodeStore(threadSessionDir!) : null;
        const nextId = (store?.episodes.length ?? 0) + 1;
        const rawOutput = getFinalOutput(runResult.messages);
        const episode: Episode = {
          id: nextId,
          timestamp: new Date().toISOString(),
          objective: params.task.slice(0, 200),
          key_findings: [],
          conclusions: rawOutput,
          files_read: [],
          files_modified: [],
        };

        if (isNamed) {
          appendEpisode(threadSessionDir!, params.name!, agent.name, episode);
        }

        const r: ThreadRunResult = {
          threadName: params.name,
          episode,
          runResult,
          seededFrom,
        };

        return {
          content: [{ type: "text", text: rawOutput }],
          details: {
            mode: isNamed ? "thread" : "ephemeral",
            results: [r],
          } as ToolDetails,
        };
      } finally {
        if (seedFileResult) cleanupDir(seedFileResult.dir);
      }
    },

    renderCall(args, theme) {
      return renderCall(args as Record<string, unknown>, theme as Parameters<typeof renderCall>[1]);
    },

    renderResult(result, options, theme) {
      return renderResult(
        result as Parameters<typeof renderResult>[0],
        options,
        theme as Parameters<typeof renderResult>[2],
      );
    },
  });

  // ── thread_status tool ────────────────────────────────────────────────────
  pi.registerTool({
    name: "thread_status",
    label: "Thread Status",
    description: "Inspect episode history for a named thread.",
    parameters: ThreadStatusParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
      if (!params.name) {
        const threads = listThreads(parentSessionFile);
        const text =
          threads.length === 0
            ? "No active threads."
            : threads
                .map(
                  (t) =>
                    `${t.name}: ${t.episodeCount} episode(s), agent=${t.agentName ?? "default"}, last=${new Date(t.lastActivity).toLocaleString()}`,
                )
                .join("\n");
        return { content: [{ type: "text", text }], details: { mode: "list" as const, threads } };
      }

      const dir = getThreadDir(parentSessionFile, params.name);
      const store = readEpisodeStore(dir);
      if (!store) {
        return {
          content: [{ type: "text", text: `Thread "${params.name}" not found.` }],
          details: { mode: "episodes" as const, threadEpisodes: [] },
        };
      }
      const text = store.episodes
        .map((ep) => `[${ep.id}] ${ep.objective}\n  ${ep.conclusions.slice(0, 150)}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: text || "No episodes yet." }],
        details: { mode: "episodes" as const, threadEpisodes: store.episodes },
      };
    },

    renderCall(args, theme) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const T = (c: string, t: string) => (theme as any).fg(c, t);
      const name = typeof args.name === "string" ? args.name : "?";
      return new Text(
        T("toolTitle", (theme as any).bold("thread_status ")) + T("accent", name),
        0, 0,
      );
    },
  });
  } // end depth === 0 guard for thread tools

  // ── /run command ──────────────────────────────────────────────────────────
  pi.registerCommand("run", {
    description: "Run an agent: /run <agent> <task>  or  /run <name>:<agent> <task> (named thread)",
    getArgumentCompletions: (prefix) => {
      if (prefix.includes(" ")) return null;
      const { agents } = discoverAgents(process.cwd(), "both");
      return agents
        .filter((a) => a.name.startsWith(prefix.replace(/^[^:]+:/, "")))
        .map((a) => ({ value: a.name, label: `${a.name} (${a.source})` }));
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) { ctx.ui.notify("Usage: /run <agent> <task>", "error"); return; }
      const space = input.indexOf(" ");
      if (space === -1) { ctx.ui.notify("Usage: /run <agent> <task>", "error"); return; }
      const token = input.slice(0, space);
      const task = input.slice(space + 1).trim();
      if (!task) { ctx.ui.notify("Usage: /run <agent> <task>", "error"); return; }

      // Support "name:agent" syntax for named threads
      const colon = token.indexOf(":");
      const name = colon !== -1 ? token.slice(0, colon) : undefined;
      const agent = colon !== -1 ? token.slice(colon + 1) : token;

      const params: Record<string, unknown> = { task, agent, agentScope: "both" };
      if (name) params.name = name;
      pi.sendUserMessage(
        `Call the thread tool with these exact parameters: ${JSON.stringify(params)}`,
      );
    },
  });

  // ── /chain command ────────────────────────────────────────────────────────
  pi.registerCommand("chain", {
    description: 'Chain agents: /chain agent1 "task1" -> agent2 "task2"',
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input.includes(" -> ")) {
        ctx.ui.notify('Usage: /chain agent1 "task1" -> agent2 "task2"', "error");
        return;
      }
      const segments = input.split(" -> ").map((s) => s.trim()).filter(Boolean);
      const chain: Array<{ agent: string; task?: string }> = [];
      for (const seg of segments) {
        const qMatch = seg.match(/^(\S+)\s+"([^"]*)"$/) ?? seg.match(/^(\S+)\s+'([^']*)'$/);
        if (qMatch) {
          chain.push({ agent: qMatch[1], task: qMatch[2] });
        } else {
          chain.push({ agent: seg });
        }
      }
      if (chain.length === 0) return;
      pi.sendUserMessage(
        `Call the thread tool with these exact parameters: ${JSON.stringify({ chain, agentScope: "both" })}`,
      );
    },
  });

  // ── /thread command ───────────────────────────────────────────────────────
  pi.registerCommand("thread", {
    description: "Manage threads: /thread list  |  /thread episodes <name>  |  /thread destroy <name>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const action = parts[0];
      if (action === "list" || !action) {
        pi.sendUserMessage(`Call the thread tool with these exact parameters: ${JSON.stringify({ list: true })}`);
      } else if (action === "episodes" && parts[1]) {
        pi.sendUserMessage(
          `Call the thread tool with these exact parameters: ${JSON.stringify({ episodes: parts[1] })}`,
        );
      } else if (action === "destroy" && parts[1]) {
        pi.sendUserMessage(
          `Call the thread tool with these exact parameters: ${JSON.stringify({ destroy: parts[1] })}`,
        );
      } else {
        ctx.ui.notify(
          "Usage: /thread list | /thread episodes <name> | /thread destroy <name>",
          "error",
        );
      }
    },
  });
}
