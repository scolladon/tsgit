# Code navigation — serena / graft / tokensave (global context)

Injected verbatim into every craft agent AND read by the session at the branch phase. Activation and the merge-phase prune (`serena-prune.sh`) are a matched pair — every activated worktree gets pruned.

Three tools, three jobs. They are not interchangeable; their blind spots differ. Evidence and measurements: `docs/spike/code-graph-tool-selection.md`.

## Routing — pick by task, not by habit

**Ask first: is there a mechanical oracle?** If a compiler, a bundler or a doc generator already
computes the answer, use it — it is exhaustive where a graph query is a sample, and it is ground
truth where a graph is a model. Only when no oracle applies does the table below start.

| Task | Tool |
|---|---|
| **"did the exported surface change?"** | **regenerate `reports/api.json`, diff it** — not a graph |
| **anything about the build/emit pipeline** | **`tsc --noEmit`, `npm run build`** — graphs model source, not emit |
| cold-start orientation, "how does X work", "where does Y live" | `graft ask` (Bash or `graft_find_code`) |
| file shape, cheapest possible | `get_symbols_overview` (names only) |
| file shape + signatures + line ranges | `graft skeleton` |
| exact references before an edit | `find_referencing_symbols` |
| **navigating across a barrel / `export type *`** | **serena only** |
| read one symbol's body | `find_symbol` (`include_body`) |
| rename / replace a symbol body | serena — the only one that writes safely |
| type errors after an edit | `get_diagnostics_for_file` |
| import cycles, god classes, coupling, DSM, churn/blame | tokensave — **verify every entry by hand** |

The barrel row is about **navigation** — "who uses this re-exported symbol", before an edit. It is
not the tool for **verification** — "did the surface change". Regenerating `api.json` and diffing
the symbol set answers that over the whole surface at once; `find_referencing_symbols` answers it
one symbol at a time and only for the symbols you thought to ask about.

Loop: `graft ask` → `graft skeleton` → `serena find_symbol` / `find_referencing_symbols` → `serena replace_*`. tokensave is a **periodic audit**, not a per-task tool.

Cost ladder on a 1,254-line file — `get_symbols_overview` ~1.1 KB (no signatures) < `graft skeleton` 8.6 KB (full TS signatures) < raw `Read` 50.7 KB. Overview to decide, skeleton to work, `Read` almost never.

## What a full run actually measured (2026-08-29, reflog-parity run)

This file is injected into every craft agent. Measured across the 21 agents of one
full run: **17 used zero MCP tools** — pure Bash/Read/Edit — and every one passed its
gates first-spawn; the 4 that did use serena/graft used them successfully, with no
observable quality difference at part granularity. Two structural reasons: subagent
MCP schemas are deferred (a ToolSearch round-trip before first use), and the shell is
always warm. Read the table above as BINDING for the session's own precision work —
where it measurably pays (sub-10% of a file read per symbol lookup; ~20 surgical
`replace_*` edits in 300–1,200-line files this run, zero mismatch failures) — and as
ADVISORY for spawned agents: enforcing it there costs more than it buys.

## Serena — the precision and write tool

- Serena is **ALREADY ACTIVATED** here. Do NOT call `activate_project`.
- Serena symbol/LSP tools are the default for all TypeScript **edit** and **exact-reference** work (test files too): `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `rename_symbol`, `insert_after_symbol`, `replace_symbol_body`, `replace_content`. Run `get_diagnostics_for_file` after each source edit.
- Fall back to `Edit`/`Write` only when Serena can't express the change; `Read`/`Grep` only for non-code files (markdown, JSON, generated artefacts) or a quick literal scan; Bash for git/npm only.
- **`replace_symbol_body` gotcha:** replacing a TS `export const` arrow can double the `export const` prefix (TS1389) — omit the prefix in the new body, diagnose after.
- **Stale-activation recovery** (session, branch phase): `activate_project` throwing FileNotFoundError on a deleted sibling worktree means Serena cached a dead project. Fix: `mkdir` the missing path → activate the one you want → remove the placeholder.
- Session, branch phase: after creating the worktree, `mcp__serena__activate_project` with its ABSOLUTE path. Serena's LSP roots at the activated project, so navigation/rename reflect the worktree's own edits; the harness LSP is single-rooted at the main repo and sees stale declarations for worktree files.
- Diagnostics are advisory; ground truth is `npm run check:types` / `npm run validate`. Ignore lagging cross-root diagnostics when the type-check is green.
- `find_referencing_symbols` on a widely-used symbol returns tens of KB (55 KB for one dispatcher, mostly test references). The harness persists oversized results to a file — filter that file with a script instead of re-querying.

## graft — cheap breadth, never authority

- Deterministic tier only. **Never run `graft build --deep`** — it generates an LLM prose layer that would drift against the ADRs and compete with them as a source of truth.
- The graph is a cache under `graft/` (git-ignored). Refresh with `graft build` (~1.5s incremental); `graft check` verifies freshness.
- In a fresh worktree the graph does not exist — run `graft build` once, or skip graft and use serena.
- graft answers *where* and *what shape*. It never authorises an edit; confirm with serena before changing anything.
- `graft_trace_calls` drops cross-file edges for AMBIGUOUS same-name symbols (three definitions of `readReflog` → zero callers reported, with a warning). Any multi-definition name is a serena `find_referencing_symbols` question, exactly like the barrel rule.
- Its "tokens saved" banners assume every touched file would have been read whole, repeatedly — treat them as marketing, not measurement (one agent's banner claimed ~559k saved from 7 calls).
- Do **not** grep `graft/`. Its cards are derived duplicates of `src/`, and a card left stale by a skipped build reads as a real hit. `graft build` re-appends a `!graft/` re-admit to `.ignore` every run, so the exclusion is pinned in the committed `.rgignore` (ripgrep prefers it) and `.ignore` itself is git-ignored. Query graft with graft's own tools.

## tokensave — analytics, not navigation

- Use for what the other two cannot compute: `circular`, `god_class`, `coupling`, `dsm`, `hotspots`, `blame`, `complexity`. A full feature run (2026-08-29) produced ZERO analytics triggers — the audit cadence is per-quarter, not per-task.
- Its Bash grep hook misfires: it blocked literal scans this table explicitly allows, its message names tools that do not exist as named (`tokensave_search` → the real form is `tokensave tool search`), and it fires in fresh worktrees where tokensave has NO index (graft seeds its graph from the parent checkout; tokensave needs a full `tokensave init` per worktree). On a misfire against an allowed literal scan, `TOKENSAVE_DISABLE_GREP_HOOK=1` on that one command is the sanctioned override.
- **Its findings are neither sound nor complete — verify each one against the source before acting.** A `circular` run here reported 7 cycles: 2 were noise (an SCC dumped alphabetically as if it were a path; a pair with no reverse edge), and one of the 5 real ones was actually 13 instances of the same shape, of which it listed one. A short list reads as reassurance and is the more dangerous error. It also cannot tell a `import type` edge (erased at build, harmless) from a value edge.
- **Do not use `tokensave_context` for orientation** — measured at ~2× graft's cost with worse recall on this repo.
- **Do not trust `dead_code` unfiltered** — 37,284 hits here, including `describe(...)` blocks in test files. Scope to `src/` or ignore.
- A tokensave version bump implies a **DB schema migration and a full re-index**. Incremental `sync` will keep reporting success against a half-built graph. Run `tokensave doctor` after every upgrade.

## Shared blind spot — the emit pipeline

All three tools model the **source** graph. They are blind to what `tsc` and the bundler do to it,
so two edits that are structurally identical in the source can diverge in the build. `tsgit` sets
`stripInternal: true` in `tsconfig.build.json`: an `@internal` declaration is erased from the
emitted `.d.ts`, but an `export type { X } from './y.js'` re-export of it is left dangling, and
`rollup-plugin-dts` fails with `"X" is not exported by "y.ts"`. An `@internal` type therefore
cannot be re-exported through a facade — its consumers import it from its own module. No graph
query predicts this; `npm run build` is the only oracle.

Related: the `.d.ts` bundle shares a wireit script with the JS bundles, so a dts-only failure is
still labelled `[build:js]`. Read the rollup target header (`→ dist/types`), not the label.

## Shared blind spot — barrels

All three graph tools extract **zero symbols** from `src/application/primitives/index.ts` (75 exports, 17 importers) and `src/public-types.ts`, because tree-sitter grammars do not handle `export type *`. codegraph additionally reports "no other indexed file depends on it", which is false.

Any question of the form "who uses this re-exported symbol" is a **serena** job. Do not accept a graph tool's silence as evidence of no callers.

## headroom — not part of the loop

Wired as an MCP server but measured dead in the 2026-08-29 run: its compression proxy
was unreachable the whole session (`headroom_stats` → 0 compressions, 0 retrievals,
proxy ConnectError), and no trigger arose — the one oversized tool result was
persisted by the harness itself. Its one historically recorded value is
`headroom_retrieve` for reading session-compressed content. Do not route work to it;
if the proxy stays down, remove it from this repo's session config.
