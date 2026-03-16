# Execution Plan: pi-threads

**Goal:** Implement a pi extension that provides Slate-style thread/episode architecture as a replacement for pi-subagents.

**Status:** In Progress

## Phases

### Phase 1: Foundation ✅
- [x] Project structure
- [x] Execution plan + feature tracker + progress.md
- [x] types.ts — all TypeScript types
- [x] settings.ts — config loading
- [x] schemas.ts — TypeBox tool parameter schemas

### Phase 2: Core Infrastructure
- [ ] agents.ts — agent discovery (user/project/builtin)
- [ ] utils.ts — subprocess utilities (adapted from pi-subagents)
- [ ] threads.ts — thread lifecycle, registry, TTL cleanup
- [ ] episodes.ts — episode store (JSON) + extractor (cheap model)
- [ ] runner.ts — subprocess execution with session persistence

### Phase 3: Extension Entry
- [ ] render.ts — TUI rendering (collapsed/expanded views)
- [ ] index.ts — register tools + commands + shortcuts
- [ ] agents/*.md — builtin agent definitions

### Phase 4: Verification
- [ ] Install and reload
- [ ] Smoke-test: create a named thread, run an action, verify episode
- [ ] Smoke-test: chain mode
- [ ] Smoke-test: parallel mode
- [ ] Smoke-test: list/episodes/destroy

## Decision Log

### 2026-03-16: Replace pi-subagents entirely, not coexist
- **Rationale:** One delegation primitive avoids confusion between "subagent for this" vs "thread for that". Threads subsume subagents — ephemeral threads handle one-shot tasks.

### 2026-03-16: Configurable cheap model for episode extraction
- **Rationale:** Extraction doesn't need frontier intelligence. Cost matters since every thread action triggers extraction. Default to Haiku/Flash, configurable in config.json.

### 2026-03-16: 7-day TTL with auto-cleanup on session_start
- **Rationale:** Balances persistence with disk hygiene. Threads expire after 7 days from last activity. Cleanup runs on extension load.

### 2026-03-16: Pure JSON episode format
- **Rationale:** Composable, parseable, no ambiguity. Episodes are programmatic primitives, not documents.

### 2026-03-16: Rely on pi's built-in auto-compaction per thread
- **Rationale:** Each thread has its own pi session. Pi's compaction handles context management within the thread. No need for episode-level rolling/compaction.

### 2026-03-16: Use --session-dir for thread persistence (no --no-session)
- **Rationale:** Stable session dir per thread name causes pi to resume the existing session. This gives true context continuity across actions. Pi-subagents uses --no-session for ephemeral; we use stable dirs for named threads.

### 2026-03-16: Use --models (not --model) CLI flag
- **Rationale:** pi CLI silently ignores --model without a companion --provider flag. --models resolves the provider automatically via resolveModelScope (discovered in pi-subagents source).

### 2026-03-16: Episode extraction uses dedicated pi subprocess
- **Rationale:** Extension API doesn't expose direct LLM calls. Spawning pi with --no-tools --no-extensions --no-skills is clean and consistent with the rest of the extension.

## Acceptance Criteria
1. `thread({ name: "test", task: "list files in cwd" })` creates a thread and returns an episode
2. Second `thread({ name: "test", task: "now list subdirs" })` resumes the same session (has context of first action)
3. `thread({ list: true })` shows the "test" thread with 2 episodes
4. `thread({ episodes: "test" })` returns both episodes
5. `thread({ destroy: "test" })` removes the thread
6. Chain mode passes episode content as `{previous}`
7. Parallel mode returns all episodes
8. 7-day-old threads are auto-cleaned on startup
9. Uninstalling pi-subagents and installing pi-threads works cleanly
