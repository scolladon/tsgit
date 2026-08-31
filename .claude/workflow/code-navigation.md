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

## What two full runs measured (2026-08-29 reflog-parity, 2026-08-30/31 tree-bytes)

This file is injected into every craft agent. The second run added a **tool bootstrap
block** to every spawn prompt — two literal `ToolSearch` calls plus a worked example per
tool, pre-filled from that part's own context — to test whether the first run's low
adoption was a discovery problem.

It is not. The split is by **task shape**, not by prompting:

| | agents | zero-MCP | MCP calls |
|---|---|---|---|
| agents that **edit code** | 16 | 5 | **321** |
| agents that **only read** | 6 | **6** | **0** |

Adoption overall went from 17/21 zero-MCP to 11/22, entirely on the writing side. The
bootstrap block *does* work at what it literally asks: 18 of 22 agents ran the ToolSearch
calls (the 4 that did not were sub-agents spawned by other agents, which never saw it).
But **three read-only agents loaded the tools and then used none of them** — loading and
using are separate behaviours and the block only moves the first.

The reason is task shape, and it is defensible rather than lazy. A reviewer or planner
starts with `git diff` in hand: it already knows where the change is, so the question
graft answers best — *where does X live* — is one it does not have. Its natural instrument
is Bash: run the diff, run a probe, run the suite. An implementer, by contrast, has a
symbol to rewrite, and serena's `replace_*` is genuinely the right tool for that.

**So: bind the table for editing work, and stop spending prompt space pushing read-only
agents onto graft.** The one exception worth keeping is orientation in genuinely
unfamiliar code — which a diff-scoped reviewer is not doing.

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

- Use for what the other two cannot compute: `circular`, `god_class`, `coupling`, `dsm`, `hotspots`, `blame`, `complexity`. Two full feature runs produced ZERO analytics triggers — the audit cadence is per-quarter, not per-task.
- **Its MCP server is not registered here.** `tokensave doctor` reports `MCP server NOT registered in ~/.claude.json`, so there are no `mcp__tokensave__*` tools in a session. Analytics are reachable only through the CLI: `tokensave tool <name>` (`tokensave tool` alone lists them).
- **Worktree recipe, measured — the cost is not the objection.** `tokensave init` in a fresh worktree took **8 s** (7.0 s indexing, 2,949 files, 79,233 nodes, 150,291 edges) and `tokensave branch add <branch>` copies the ancestor DB in **1 s** and works correctly from a worktree. The real costs are disk — **238 MB per DB**, against graft's 85 MB, and a tracked branch is a second full copy — and that none of it earned anything in two runs.
- **`tokensave doctor` is not read-only.** It VACUUMs the database *and* rewrites `~/.claude/settings.json` — observed widening the PreToolUse matcher from `Agent|Grep|Bash` to `Agent|Grep|Bash|Glob` without asking. Treat it as a mutating command; check `git diff` on your settings afterwards.
- **The grep hook still misfires, and an index does not fix it.** It blocked `grep -rn "parseTreeContent" src --include="*.ts"` in a worktree with a complete index, while the identical pattern piped through `sed` had passed seconds earlier. It fires on `rg` as well as `grep`, so it matches the command text rather than the tool. Its message still names `tokensave_search` / `tokensave_callers_for`, which exist in no form when the MCP server is unregistered. `TOKENSAVE_DISABLE_GREP_HOOK=1` on the one command remains the sanctioned override.
- **Its findings are neither sound nor complete — verify each one against the source before acting.** A `circular` run here reported 7 cycles: 2 were noise, and one of the 5 real ones was 13 instances of the same shape, of which it listed one. A short list reads as reassurance and is the more dangerous error. It also cannot tell an `import type` edge from a value edge.
- **Do not use `tokensave_context` for orientation** — measured at ~2× graft's cost with worse recall on this repo.
- **Do not trust `dead_code` unfiltered** — 37,284 hits here, including `describe(...)` blocks in test files.
- A version bump implies a **DB schema migration and a full re-index**. Incremental `sync` keeps reporting success against a half-built graph. Run `tokensave doctor` after every upgrade — accepting that it will also edit your settings.

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

## headroom — a compression proxy, not a navigation tool

It was listed here at all because it was wired as an MCP server. That was a category
error: headroom is an **LLM-traffic proxy that lossily compresses tool output before the
model sees it**. It answers no navigation question and belongs in this file only as a
warning.

- **Why it measured "dead" in the first run was mundane.** The CLI is installed
  (`~/.local/bin/headroom`), but nothing was listening on `127.0.0.1:8787` — `headroom
  proxy` is a daemon and no one had started it. The MCP server was wired to a proxy that
  did not exist. It is now unwired entirely, and no `mcp__headroom__*` tools appear.
- **To use it at all** you run `headroom proxy` (binds `127.0.0.1:8787`) and point the
  client at it — `ANTHROPIC_BASE_URL=http://localhost:8787` or `headroom wrap claude`.
  `/health`, `/stats` and `/metrics` report what it did.
- **Do not put it in front of this repo's work.** Compression is lossy by design: its own
  documentation says it preserves keys, brackets, signatures, timestamps and hashes while
  compressing "long string values, whitespace, function bodies, comments, repeated log
  patterns", and it states no size threshold and no accuracy caveat. The original bytes
  are recoverable only if CCR storage is enabled. This repo's prime directive is
  byte-for-byte faithfulness to git, and its evidence is exactly the shape headroom
  discards — `ls-tree` rendering `"\357\273\277a"`, hex dumps of `EF BB BF`, 40-char
  oids, git's literal `error: malformed mode in tree entry`. A parity conclusion drawn
  from compressed probe output is worthless.
- **Where it could genuinely pay:** bulk, low-entropy, non-load-bearing output — CI logs,
  dependency trees, large JSON fixtures being skimmed rather than verified. If it is ever
  wired again, wire it for those and keep it off the path that carries git's bytes.
