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

  if (Array.isArray(args.tasks)) {
    return new Text(
      T("toolTitle", theme.bold("thread ")) + T("accent", `parallel (${(args.tasks as unknown[]).length})`),
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
  if (results.length === 0) {
    return new Text(T("muted", "(running…)"), 0, 0);
  }

  const renderEpisode = (ep: Episode, expanded: boolean): string => {
    const lines = [`${T("success", "✓ ")}${T("accent", ep.objective)}`];
    if (expanded) {
      for (const f of ep.key_findings) lines.push(T("dim", `  • ${f}`));
      if (ep.conclusions) lines.push(`  ${ep.conclusions.slice(0, 200)}`);
      if (ep.files_read.length > 0)
        lines.push(T("muted", `  read: ${ep.files_read.slice(0, 3).join(", ")}${ep.files_read.length > 3 ? "…" : ""}`));
      if (ep.files_modified.length > 0)
        lines.push(T("warning", `  modified: ${ep.files_modified.slice(0, 3).join(", ")}${ep.files_modified.length > 3 ? "…" : ""}`));
    }
    return lines.join("\n");
  };

  if (results.length === 1) {
    const r = results[0];
    const isError = r.runResult.exitCode !== 0;
    const icon = isError ? T("error", "✗ ") : T("success", "✓ ");
    const threadLabel = r.threadName ? T("accent", r.threadName) : T("muted", "ephemeral");
    const ep = r.episode;
    const usage = formatUsage(r.runResult.usage);

    if (!options.expanded) {
      let text = `${icon}${threadLabel} — ${T("accent", ep.objective)}`;
      if (ep.key_findings.length > 0)
        text += `\n  ${T("dim", ep.key_findings.slice(0, 2).join(" · "))}`;
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
    container.addChild(new Text(T("muted", "── Objective ──"), 0, 0));
    container.addChild(new Text(ep.objective, 0, 0));

    if (ep.key_findings.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("muted", "── Key Findings ──"), 0, 0));
      for (const f of ep.key_findings)
        container.addChild(new Text(T("dim", `• ${f}`), 0, 0));
    }

    if (ep.conclusions) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("muted", "── Conclusions ──"), 0, 0));
      container.addChild(new Text(ep.conclusions, 0, 0));
    }

    if (ep.file_refs && ep.file_refs.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("muted", "── Code References ──"), 0, 0));
      for (const ref of ep.file_refs) {
        const loc = ref.line !== undefined ? `${ref.file}:${ref.line}` : ref.file;
        container.addChild(new Text(T("accent", loc) + T("dim", ` — ${ref.context}`), 0, 0));
      }
    }

    if (ep.files_read.length > 0 || ep.files_modified.length > 0) {
      container.addChild(new Spacer(1));
      if (ep.files_read.length > 0)
        container.addChild(new Text(T("muted", `read: ${ep.files_read.join(", ")}`), 0, 0));
      if (ep.files_modified.length > 0)
        container.addChild(new Text(T("warning", `modified: ${ep.files_modified.join(", ")}`), 0, 0));
    }

    if (usage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("dim", usage), 0, 0));
    }
    return container;
  }

  // Multiple results (parallel / chain)
  const isChain = details.mode === "chain";
  const label = isChain ? "chain" : "parallel";
  const icon = T("success", "✓ ");

  if (!options.expanded) {
    let text = `${icon}${T("toolTitle", theme.bold(label))} ${T("accent", `${results.length} episode(s)`)}`;
    for (const r of results.slice(0, 3)) {
      const threadLabel = r.threadName ?? "step";
      text += `\n  ${T("accent", threadLabel)}: ${T("dim", r.episode.objective.slice(0, 60))}`;
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
    const stepLabel = isChain ? `Step ${i + 1}` : `Task ${i + 1}`;
    const threadLabel = r.threadName ?? "ephemeral";
    container.addChild(
      new Text(T("muted", `── ${stepLabel}: `) + T("accent", threadLabel), 0, 0),
    );
    container.addChild(new Text(renderEpisode(r.episode, true), 0, 0));
  }
  return container;
}
