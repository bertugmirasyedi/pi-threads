/**
 * pi-threads: TypeBox schemas for tool parameters
 */

import { Type } from "@sinclair/typebox";

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

const AgentScopeSchema = Type.Optional(
  Type.Union(
    [
      Type.Literal("user"),
      Type.Literal("project"),
      Type.Literal("both"),
    ],
    { description: 'Agent discovery scope. Default: "both".' },
  ),
);

const ParallelTask = Type.Object({
  task: Type.String({ description: "Task for this parallel slot." }),
  agent: Type.Optional(Type.String({ description: "Agent to use for this slot." })),
  name: Type.Optional(Type.String({ description: "If set, this slot uses a persistent named thread." })),
  model: Type.Optional(Type.String({ description: "Model override for this slot." })),
});

const ChainStep = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent for this step. Uses defaultAgent if omitted." })),
  task: Type.Optional(
    Type.String({
      description:
        "Task for this step. Use {task} for the original task, {previous} for the prior step's episode. Step 1 must have a task.",
    }),
  ),
  name: Type.Optional(Type.String({ description: "If set, this step uses a persistent named thread." })),
  model: Type.Optional(Type.String({ description: "Model override for this step." })),
});

// ─── Main thread tool schema ─────────────────────────────────────────────────

export const ThreadParams = Type.Object({
  // ── Execution: single/thread ──
  task: Type.Optional(
    Type.String({
      description:
        "Task to execute. Combine with 'name' for a persistent thread. Without 'name', creates an ephemeral one-shot.",
    }),
  ),

  // ── Execution: parallel ──
  tasks: Type.Optional(
    Type.Array(ParallelTask, {
      description: "Array of tasks to run concurrently. Each returns an episode.",
    }),
  ),

  // ── Execution: chain ──
  chain: Type.Optional(
    Type.Array(ChainStep, {
      description:
        "Sequential chain. Each step's episode becomes {previous} for the next step. First step must have a task.",
    }),
  ),

  // ── Thread options ──
  name: Type.Optional(
    Type.String({
      description:
        "Thread name. If provided, the thread persists across calls (context is resumed). Use for multi-step workstreams.",
    }),
  ),
  agent: Type.Optional(
    Type.String({ description: "Agent config to use. Falls back to defaultAgent if not found." }),
  ),
  model: Type.Optional(Type.String({ description: "Model override for this action." })),
  seed_from: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Thread names whose episodes are injected into this action's context. Use to compose findings across workstreams.",
    }),
  ),
  agentScope: AgentScopeSchema,

  // ── Management ──
  list: Type.Optional(Type.Boolean({ description: "List all active threads with episode counts and age." })),
  episodes: Type.Optional(Type.String({ description: "Return full episode history for this thread name." })),
  destroy: Type.Optional(Type.String({ description: "Destroy a named thread and delete its session data." })),
});

// ─── thread_status schema ────────────────────────────────────────────────────

export const ThreadStatusParams = Type.Object({
  name: Type.Optional(Type.String({ description: "Thread name to inspect." })),
});
