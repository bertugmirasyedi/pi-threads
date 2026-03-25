/**
 * pi-threads: TUI rendering
 */

import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import type { LiveToolCall, ToolDetails } from "./types.js";

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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function summarizeToolArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  const preferred = ["path", "file", "command", "query", "pattern", "url", "name", "action", "id"];
  const pairs = preferred
    .filter((key) => key in args)
    .slice(0, 2)
    .map((key) => args[key]);
  const values = (pairs.length > 0 ? pairs : Object.values(args).slice(0, 2))
    .map((value) => {
      if (typeof value === "string") return truncate(value, 48);
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (Array.isArray(value)) return truncate(value.map((item) => String(item)).join(", "), 48);
      if (value && typeof value === "object") return truncate(JSON.stringify(value), 48);
      return "";
    })
    .filter(Boolean);
  return values.length > 0 ? values.join(" · ") : undefined;
}

function extractToolCalls(messages: any[]): LiveToolCall[] {
  const calls: LiveToolCall[] = [];
  const byId = new Map<string, LiveToolCall>();

  for (const msg of messages ?? []) {
    if (msg?.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part?.type !== "toolCall") continue;
        const call: LiveToolCall = {
          id: part.id,
          name: part.name ?? "tool",
          args: part.arguments,
          summary: summarizeToolArgs(part.arguments),
          status: "success",
        };
        calls.push(call);
        if (part.id) byId.set(part.id, call);
      }
    }

    if (msg?.role === "toolResult") {
      const existing = msg.toolCallId ? byId.get(msg.toolCallId) : undefined;
      if (existing) {
        existing.status = msg.isError ? "error" : "success";
      } else {
        calls.push({
          id: msg.toolCallId,
          name: msg.toolName ?? "tool",
          summary: undefined,
          status: msg.isError ? "error" : "success",
        });
      }
    }
  }

  return calls;
}

function formatToolCallLine(call: LiveToolCall, theme: Theme): string {
  const T = (c: string, t: string) => theme.fg(c, t);
  const status = call.status === "running"
    ? T("accent", "●")
    : call.status === "error"
      ? T("error", "✗")
      : T("success", "✓");
  const summary = call.summary ? ` ${T("dim", truncate(call.summary, 80))}` : "";
  return `${status} ${T("accent", call.name)}${summary}`;
}

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

  // Running state: show live tool timeline + output tail
  if (details.running) {
    const tail = details.outputTail ?? [];
    const liveToolCalls = details.liveToolCalls ?? [];
    const maxCalls = options.expanded ? 6 : 4;
    const maxTail = options.expanded ? 3 : 1;
    const lines = [
      `${T("accent", "⟳")} ${T("muted", "running")}${details.activityLabel ? ` ${T("accent", details.activityLabel)}` : ""}`,
    ];

    const visibleCalls = liveToolCalls.slice(-maxCalls);
    if (visibleCalls.length > 0) {
      lines.push(T("muted", "  │"));
      for (let i = 0; i < visibleCalls.length; i++) {
        const connector = i === visibleCalls.length - 1 && tail.length === 0 ? "  └─ " : "  ├─ ";
        lines.push(`${T("muted", connector)}${formatToolCallLine(visibleCalls[i], theme)}`);
      }
      if (liveToolCalls.length > visibleCalls.length) {
        lines.push(T("muted", `  │  … +${liveToolCalls.length - visibleCalls.length} earlier tool call(s)`));
      }
    }

    const visibleTail = tail.slice(-maxTail);
    if (visibleTail.length > 0) {
      lines.push(T("muted", visibleCalls.length > 0 ? "  │" : "  ├─ output"));
      for (let i = 0; i < visibleTail.length; i++) {
        const prefix = i === visibleTail.length - 1 ? "  └─ " : "  ├─ ";
        lines.push(T("dim", `${prefix}${truncate(visibleTail[i], 100)}`));
      }
    }

    if (liveToolCalls.length === 0 && visibleTail.length === 0) {
      lines.push(T("muted", "  waiting for first tool call or response…"));
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
    const toolCalls = extractToolCalls(r.runResult.messages);

    if (!options.expanded) {
      let text = `${icon}${threadLabel} — ${T("accent", ep.objective)}`;
      if (toolCalls.length > 0)
        text += `\n  ${T("muted", `tools: ${toolCalls.slice(0, 3).map((call) => call.name).join(" · ")}`)}`;
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
    container.addChild(new Spacer(1));
    container.addChild(new Text(T("muted", "── Output ──"), 0, 0));
    container.addChild(new Text(ep.conclusions, 0, 0));

    if (toolCalls.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(T("muted", "── Tool Calls ──"), 0, 0));
      for (const call of toolCalls) {
        container.addChild(new Text(formatToolCallLine(call, theme), 0, 0));
      }
    }

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
    const toolCalls = extractToolCalls(r.runResult.messages);
    if (toolCalls.length > 0) {
      container.addChild(new Text(T("muted", `tools: ${toolCalls.map((call) => call.name).join(" · ")}`), 0, 0));
    }
  }
  return container;
}
