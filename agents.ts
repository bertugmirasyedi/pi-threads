/**
 * pi-threads: Agent discovery
 * Resolves agent configs from user, project, and builtin locations.
 * Priority: project > user > builtin
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, AgentScope } from "./types.js";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-threads");
const BUILTIN_AGENTS_DIR = path.join(EXTENSION_DIR, "agents");
const USER_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "agents");

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  thinking?: string;
  skills?: string;
  extensions?: string;
}

function parseFrontmatter(content: string): { meta: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim() as keyof Frontmatter;
    const value = line.slice(colon + 1).trim();
    if (key && value) (meta as Record<string, string>)[key] = value;
  }
  return { meta, body: match[2].trim() };
}

function parseAgentFile(
  filePath: string,
  source: AgentConfig["source"],
): AgentConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name ?? path.basename(filePath, ".md");
    const tools = meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const skills = meta.skills ? meta.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const extensions =
      meta.extensions !== undefined
        ? meta.extensions === ""
          ? []
          : meta.extensions.split(",").map((e) => e.trim()).filter(Boolean)
        : undefined;
    return {
      name,
      description: meta.description,
      source,
      systemPrompt: body,
      tools,
      model: meta.model,
      thinking: meta.thinking,
      skills,
      extensions,
    };
  } catch {
    return null;
  }
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseAgentFile(path.join(dir, f), source))
    .filter((a): a is AgentConfig => a !== null);
}

// ─── Project agents: walk up from cwd ────────────────────────────────────────

function findProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, ".pi", "agents");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AgentDiscovery {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export function discoverAgents(cwd: string, scope: AgentScope = "both"): AgentDiscovery {
  const builtins = scope !== "project" ? loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin") : [];
  const userAgents = scope !== "project" ? loadAgentsFromDir(USER_AGENTS_DIR, "user") : [];

  let projectAgentsDir: string | null = null;
  let projectAgents: AgentConfig[] = [];
  if (scope !== "user") {
    projectAgentsDir = findProjectAgentsDir(cwd);
    if (projectAgentsDir) projectAgents = loadAgentsFromDir(projectAgentsDir, "project");
  }

  // Merge: project > user > builtin (higher-priority sources override same name)
  const seen = new Set<string>();
  const agents: AgentConfig[] = [];
  for (const agent of [...projectAgents, ...userAgents, ...builtins]) {
    if (!seen.has(agent.name)) {
      seen.add(agent.name);
      agents.push(agent);
    }
  }

  return { agents, projectAgentsDir };
}

export function findAgent(
  agents: AgentConfig[],
  name: string,
  defaultAgent: string,
): AgentConfig | undefined {
  return agents.find((a) => a.name === name) ?? agents.find((a) => a.name === defaultAgent);
}
