/**
 * pi-threads: TypeScript types
 */

// ─── Episode ────────────────────────────────────────────────────────────────

export interface FileRef {
  file: string;
  line?: number;
  context: string; // why this specific location matters
}

export interface Episode {
  id: number;
  timestamp: string;
  objective: string;
  key_findings: string[];
  conclusions: string;
  files_read: string[];
  files_modified: string[];
  file_refs?: FileRef[];  // specific file:line pointers for actionable findings
}

// ─── Thread ─────────────────────────────────────────────────────────────────

export interface ThreadEpisodeStore {
  threadName: string;
  agentName?: string;
  created: string;
  lastActivity: string;
  episodes: Episode[];
}

export interface ThreadInfo {
  name: string;
  agentName?: string;
  created: string;
  lastActivity: string;
  episodeCount: number;
  sessionDir: string;
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface RunResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  exitCode: number;
  usage: UsageStats;
  error?: string;
  model?: string;
}

export interface ThreadRunResult {
  threadName?: string;          // undefined = ephemeral
  episode: Episode;
  runResult: RunResult;
  seededFrom?: string[];
}

// ─── Tool Details (for TUI rendering) ───────────────────────────────────────

export type ToolMode =
  | "thread"      // named persistent action
  | "ephemeral"   // one-shot
  | "parallel"    // concurrent tasks
  | "chain"       // sequential steps
  | "list"        // management: list threads
  | "episodes"    // management: show episodes for a thread
  | "destroy";    // management: destroy a thread

export interface ToolDetails {
  mode: ToolMode;
  results?: ThreadRunResult[];      // execution modes
  threads?: ThreadInfo[];           // list mode
  threadEpisodes?: Episode[];       // episodes mode
  destroyedThread?: string;         // destroy mode
  running?: boolean;                // true while thread subprocess is executing
  outputTail?: string[];            // last N lines of live output for in-progress display
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export type AgentScope = "user" | "project" | "builtin" | "both";

export interface AgentConfig {
  name: string;
  description?: string;
  source: "user" | "project" | "builtin";
  systemPrompt: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  skills?: string[];
  extensions?: string[];
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  sessionDir?: string;       // if set, creates/resumes session there; no --no-session
  ephemeral?: boolean;       // if true, use --no-session (ignore sessionDir for persistence)
  seedFile?: string;         // path to temp file with episode seed content for --append-system-prompt
  modelOverride?: string;
  onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: ToolDetails }) => void;
}

// ─── Display ─────────────────────────────────────────────────────────────────

export interface DisplayItem {
  type: "text" | "tool";
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
}
