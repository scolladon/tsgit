# Code navigation — serena / graft / tokensave (global context)

Injected verbatim into every craft agent AND read by the session at the branch phase. Activation and the merge-phase prune (`serena-prune.sh`) are a matched pair — every activated worktree gets pruned.

Three tools, three jobs. They are not interchangeable; their blind spots differ. Evidence and measurements: `docs/spike/code-graph-tool-selection.md`.

## Routing — pick by task, not by habit

| Task | Tool |
|---|---|
| cold-start orientation, "how does X work", "where does Y live" | `graft ask` (Bash or `graft_find_code`) |
| file shape, cheapest possible | `get_symbols_overview` (names only) |
| file shape + signatures + line ranges | `graft skeleton` |
| exact references before an edit | `find_referencing_symbols` |
| **anything crossing a barrel / `export type *`** | **serena only** |
| read one symbol's body | `find_symbol` (`include_body`) |
| rename / replace a symbol body | serena — the only one that writes safely |
| type errors after an edit | `get_diagnostics_for_file` |
| import cycles, god classes, coupling, DSM, churn/blame | tokensave |

Loop: `graft ask` → `graft skeleton` → `serena find_symbol` / `find_referencing_symbols` → `serena replace_*`. tokensave is a **periodic audit**, not a per-task tool.

Cost ladder on a 1,254-line file — `get_symbols_overview` ~1.1 KB (no signatures) < `graft skeleton` 8.6 KB (full TS signatures) < raw `Read` 50.7 KB. Overview to decide, skeleton to work, `Read` almost never.

## Serena — the precision and write tool

- Serena is **ALREADY ACTIVATED** here. Do NOT call `activate_project`.
- Serena symbol/LSP tools are the default for all TypeScript **edit** and **exact-reference** work (test files too): `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `rename_symbol`, `insert_after_symbol`, `replace_symbol_body`, `replace_content`. Run `get_diagnostics_for_file` after each source edit.
- Fall back to `Edit`/`Write` only when Serena can't express the change; `Read`/`Grep` only for non-code files (markdown, JSON, generated artefacts) or a quick literal scan; Bash for git/npm only.
- **`replace_symbol_body` gotcha:** replacing a TS `export const` arrow can double the `export const` prefix (TS1389) — omit the prefix in the new body, diagnose after.
- **Stale-activation recovery** (session, branch phase): `activate_project` throwing FileNotFoundError on a deleted sibling worktree means Serena cached a dead project. Fix: `mkdir` the missing path → activate the one you want → remove the placeholder.
- Session, branch phase: after creating the worktree, `mcp__serena__activate_project` with its ABSOLUTE path. Serena's LSP roots at the activated project, so navigation/rename reflect the worktree's own edits; the harness LSP is single-rooted at the main repo and sees stale declarations for worktree files.
- Diagnostics are advisory; ground truth is `npm run check:types` / `npm run validate`. Ignore lagging cross-root diagnostics when the type-check is green.

## graft — cheap breadth, never authority

- Deterministic tier only. **Never run `graft build --deep`** — it generates an LLM prose layer that would drift against the ADRs and compete with them as a source of truth.
- The graph is a cache under `graft/` (git-ignored). Refresh with `graft build` (~1.5s incremental); `graft check` verifies freshness.
- In a fresh worktree the graph does not exist — run `graft build` once, or skip graft and use serena.
- graft answers *where* and *what shape*. It never authorises an edit; confirm with serena before changing anything.
- Do **not** grep `graft/`. Its cards are derived duplicates of `src/`, and a card left stale by a skipped build reads as a real hit. `graft build` re-appends a `!graft/` re-admit to `.ignore` every run, so the exclusion is pinned in the committed `.rgignore` (ripgrep prefers it) and `.ignore` itself is git-ignored. Query graft with graft's own tools.

## tokensave — analytics, not navigation

- Use for what the other two cannot compute: `circular`, `god_class`, `coupling`, `dsm`, `hotspots`, `blame`, `complexity`.
- **Do not use `tokensave_context` for orientation** — measured at ~2× graft's cost with worse recall on this repo.
- **Do not trust `dead_code` unfiltered** — 37,284 hits here, including `describe(...)` blocks in test files. Scope to `src/` or ignore.
- A tokensave version bump implies a **DB schema migration and a full re-index**. Incremental `sync` will keep reporting success against a half-built graph. Run `tokensave doctor` after every upgrade.

## Shared blind spot — barrels

All three graph tools extract **zero symbols** from `src/application/primitives/index.ts` (75 exports, 17 importers) and `src/public-types.ts`, because tree-sitter grammars do not handle `export type *`. codegraph additionally reports "no other indexed file depends on it", which is false.

Any question of the form "who uses this re-exported symbol" is a **serena** job. Do not accept a graph tool's silence as evidence of no callers.
