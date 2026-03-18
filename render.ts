/**
 * pi-threads: TUI rendering
 */

import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import type { Episode, ToolDetails } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ago = Date.now() - new Date(iso).getTime();
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}

function formatUsage(usage: {
  input: number;
  output: number;
  cost: number;
  turns: number;
}): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns}t`);
  if (usage.input) parts.push(`↑${Math.round(usage.input / 100) / 10}k`);
  if (usage.output) parts.push(`↓${Math.round(usage.output / 100) / 10}k`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
};

// ─── renderCall ──────────────────────────────────────────────────────────────

export function renderCall(
  args: Record<string, unknown>,
  theme: Theme,
): InstanceType<typeof Text> {
  const T = (c: string, t: string) => theme.fg(c, t);

  if (args.list) {
    return new Text(T("toolTitle", theme.bold("thread ")) + T("accent", "list"), 0, 0);
  }
  if (args.episodes) {
    return new Text(
      T("toolTitle", theme.bold("thread ")) + T("accent", "episodes") + " " + T("muted", String(args.episodes)),
      0, 0,
    );
  }
  if (args.destroy) {
    return new Text(
      T("toolTitle", theme.bold("thread ")) + T("error", "destroy") + " " + T("accent", String(args.destroy)),
      0, 0,
    );
  }

  if (Array.isArray(args.chain)) {
    return new Text(
      T("toolTitle", theme.bold("thread ")) + T("accent", `chain (${(args.chain as unknown[]).length} steps)`),
      0, 0,
    );
  }

  // Single / named thread
  const name = args.name ? T("accent", String(args.name)) : T("muted", "ephemeral");
  const agent = args.agent ? T("dim", ` [${args.agent}]`) : "";
  const task = typeof args.task === "string"
    ? "\n  " + T("dim", args.task.length > 70 ? `${args.task.slice(0, 67)}…` : args.task)
    : "";
  return new Text(
    T("toolTitle", theme.bold("thread ")) + name + agent + task,
    0, 0,
  );
}

// ─── renderResult ─────────────────────────────────────────────────────────────

export function renderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: ToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): InstanceType<typeof Text> | InstanceType<typeof Container> {
  const T = (c: string, t: string) => theme.fg(c, t);
  const details = result.details;

  if (!details) {
    const text = result.content[0];
    return new Text(text?.type === "text" && text.text ? text.text : "(no output)", 0, 0);
  }

  // ── List mode ────────────────────────────────────────────────────────────
  if (details.mode === "list") {
    const threads = details.threads ?? [];
    if (threads.length === 0) {
      return new Text(T("muted", "No active threads."), 0, 0);
    }
    let text = T("toolTitle", theme.bold("threads ")) + T("accent", `${threads.length} active`);
    for (const t of threads) {
      const epLabel = `${t.episodeCount} ep${t.episodeCount !== 1 ? "s" : ""}`;
      const agent = t.agentName ? T("dim", ` [${t.agentName}]`) : "";
      text += `\n  ${T("accent", t.name)}${agent} ${T("muted", epLabel)} ${T("dim", relativeTime(t.lastActivity))}`;
    }
    return new Text(text, 0, 0);
  }

  // ── Episodes mode ────────────────────────────────────────────────────────
  if (details.mode === "episodes") {
    const eps = details.threadEpisodes ?? [];
    if (eps.length === 0) {
      return new Text(T("muted", "No episodes for this thread."), 0, 0);
    }
    if (!options.expanded) {
      return new Text(
        T("success", "✓ ") + T("accent", `${eps.length} episode(s)`) + T("dim", " (Ctrl+O to expand)"),
        0, 0,
      );
    }
    const container = new Container();
    container.addChild(new Text(T("toolTitle", theme.bold(`${eps.length} episodes`)), 0, 0));
    for (const ep of eps) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("muted", `── Episode ${ep.id} ──`), 0, 0));
      container.addChild(new Text(T("accent", ep.objective), 0, 0));
      for (const f of ep.key_findings) {
        container.addChild(new Text(T("dim", `  • ${f}`), 0, 0));
      }
      container.addChild(new Text(ep.conclusions, 0, 0));
    }
    return container;
  }

  // ── Destroy mode ─────────────────────────────────────────────────────────
  if (details.mode === "destroy") {
    const text = result.content[0];
    return new Text(
      T("warning", "⊗ ") + (text?.type === "text" && text.text ? text.text : "destroyed"),
      0, 0,
    );
  }

  // ── Execution modes ───────────────────────────────────────────────────────
  const results = details.results ?? [];

  // Running state: show activity feed with tool calls
  if (details.running) {
    const tail = details.outputTail ?? [];
    const currentTool = (details as any).currentTool ?? "";
    const lines: string[] = [];

    // Header with spinner and active tool
    if (currentTool) {
      lines.push(`${T("accent", "⟳")} ${T("toolTitle", theme.bold(currentTool))} ${T("dim", "running…")}`);
    } else {
      lines.push(`${T("accent", "⟳")} ${T("muted", "running…")}`);
    }

    // Activity feed — show last N lines of tool activity
    if (tail.length > 0) {
      lines.push(T("dim", "  ──────────────────────────────────────────"));
      const MAX_LINE = 120;
      const maxShow = Math.min(tail.length, 12);
      const startIdx = Math.max(0, tail.length - maxShow);
      for (let i = startIdx; i < tail.length; i++) {
        const raw = tail[i];
        const isToolCall = raw.startsWith("→ ");
        const display = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE - 1) + "…" : raw;
        if (isToolCall) {
          lines.push(`  ${T("accent", display)}`);
        } else {
          lines.push(`  ${T("dim", display)}`);
        }
      }
    }

    return new Text(lines.join("\n"), 0, 0);
  }

  if (results.length === 0) {
    return new Text(T("muted", "(running…)"), 0, 0);
  }

  if (results.length === 1) {
    const r = results[0];
    const isError = r.runResult.exitCode !== 0;
    const icon = isError ? T("error", "✗ ") : T("success", "✓ ");
    const threadLabel = r.threadName ? T("accent", r.threadName) : T("muted", "ephemeral");
    const ep = r.episode;
    const usage = formatUsage(r.runResult.usage);

    if (!options.expanded) {
      let text = `${icon}${threadLabel}`;
      if (isError && r.runResult.error)
        text += `\n  ${T("error", r.runResult.error.slice(0, 100))}`;
      if (usage) text += `\n  ${T("dim", usage)}`;
      return new Text(text, 0, 0);
    }

    const container = new Container();
    container.addChild(
      new Text(`${icon}${theme.bold(r.threadName ?? "ephemeral")} ${T("dim", `[ep ${ep.id}]`)}`, 0, 0),
    );
    container.addChild(new Spacer(1));
    container.addChild(new Text(T("muted", "── Output ──"), 0, 0));
    container.addChild(new Text(ep.conclusions, 0, 0));

    if (usage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("dim", usage), 0, 0));
    }
    return container;
  }

  // Multiple results (chain)
  const label = "chain";
  const icon = T("success", "✓ ");

  if (!options.expanded) {
    let text = `${icon}${T("toolTitle", theme.bold(label))} ${T("accent", `${results.length} episode(s)`)}`;
    for (const r of results.slice(0, 3)) {
      const threadLabel = r.threadName ?? "step";
      text += `\n  ${T("accent", threadLabel)}`;
    }
    if (results.length > 3) text += `\n  ${T("muted", `… +${results.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(
    new Text(`${icon}${theme.bold(label)} ${T("accent", `${results.length} steps`)}`, 0, 0),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    container.addChild(new Spacer(1));
    const stepLabel = `Step ${i + 1}`;
    const threadLabel = r.threadName ?? "ephemeral";
    container.addChild(
      new Text(T("muted", `── ${stepLabel}: `) + T("accent", threadLabel), 0, 0),
    );
    container.addChild(new Text(r.episode.conclusions, 0, 0));
  }
  return container;
}
