# Code navigation — hard rules first (global context)

Injected verbatim into every craft agent AND read by the session at the branch phase.
Measurements behind every claim: `docs/spike/code-graph-tool-selection.md`.

## 1. Search is truncated by default. This is a correctness rule, not a preference.

**Agents have no `Grep` and no `Glob` tool** — the inventory is `Agent, Artifact, Bash, Edit,
Read, Skill, ToolSearch, Write`. So every search runs through `Bash`, and a `PreToolUse` hook
rewrites `grep` → `rtk grep`, which **truncates at ~200 results and 25 hits per file**.
Measured: `rtk grep -rn "const" src` returned **207 lines against a real 10,311**. It appends a
`+N more files` line, but `rtk grep … | wc -l` reports the truncated count with no warning at
all.

→ **Always write `command grep`.** Never bare `grep`. Never `rtk grep | wc -l`.

Compliance when stated this way: **44/44 across two implementer agents, zero bare greps.**
Below the cap, `rtk` is byte-faithful — verified by diffing raw vs `rtk` output on a grep and
on a 43 KB `rtk read`, both identical. The hazard is truncation, not corruption.

## 2. A green `tsc` is not a consumer sweep when a type *widens*

`{crc32, offset}` → `{id, crc32, offset}` is a structural superset, so every unfixed positional
caller still type-checked and whole-project `tsc` was **green before a single call site was
touched**. One consumer surfaced only by grepping for the *value shape* (`pack.entries[i]`).

→ When you change a shape, sweep for the **shape**, not just the name. Same failure mode as a
truncated grep: a green signal that means nothing.

## 3. Ask first whether a mechanical oracle already answers it

A compiler, bundler or doc generator is exhaustive where a graph query is a sample, and ground
truth where a graph is a model.

| question | oracle |
|---|---|
| did the exported surface change? | regenerate `reports/api.json`, diff it |
| anything about build/emit | `npx tsc --noEmit -p tsconfig.json`, `npm run build` |
| import cycles | `npm run check:architecture` (`depcruise`, `no-circular` enforced) |
| dead code | `npm run check:dead-code` (`knip`) |
| duplication | `npm run check:duplicates` (`jscpd`) |

`npm run validate` gates all of these. Never hand-roll an analysis one of them already does.

## 4. The one thing only serena can do

This repo re-exports through `export type *` barrels (`src/application/primitives/index.ts`,
`src/public-types.ts`). **Every** graph tool extracts zero symbols from them.

→ Any *"who references this re-exported symbol"* question is serena's, and a graph tool's
silence is **not** evidence of no callers:
`ToolSearch("select:mcp__serena__find_referencing_symbols,mcp__serena__find_symbol")`

Serena is **already activated** on the worktree — never call `activate_project`. It is also the
safe way to rename or replace a symbol body. Gotcha: `replace_symbol_body` on a TS
`export const` arrow can double the `export const` prefix (TS1389) — omit the prefix, then
check diagnostics.

Everything else — reading files, running tests, git — is Bash's job. Don't spend calls proving
otherwise.

## 5. graft — cheap breadth, MCP only

**The `graft` CLI is broken on this machine**: `graft build` / `graft check` throw
`No native build was found … tree-sitter-kotlin` (the global install blocked scripts, so
node-gyp never ran; 0.15.0 is latest, no upgrade fixes it). **Never run it, and ignore any
instruction to `graft build` in a fresh worktree — it cannot succeed.**

The **MCP tools work and self-refresh** before each query, so no build step is needed:
`ToolSearch("select:mcp__graft__graft_find_code,mcp__graft__graft_file_api,mcp__graft__graft_trace_calls")`

Two limits: the graft MCP server is rooted at the **main checkout**, so it is blind to your
worktree's own edits — use it to read unmodified code, serena for anything you touched. And
`graft_trace_calls` drops cross-file edges for ambiguous same-name symbols (three definitions
of `readReflog` → zero callers reported). Its "tokens saved" banners assume every touched file
would otherwise have been read whole, repeatedly — marketing, not measurement.

Do **not** grep `graft/`. Its cards are derived duplicates of `src/`; a stale card reads as a
real hit. The exclusion is pinned in the committed `.rgignore`.

Cost ladder on a 1,254-line file: `get_symbols_overview` ~1.1 KB < `graft_file_api` 8.6 KB
(full signatures) < raw `Read` 50.7 KB.

## 6. tokensave — evaluated and removed, 2026-08-31

Do not reinstall it without new evidence. What the removal rested on:

- Its `PreToolUse` hook cost **10.3 ms on every `Bash`/`Grep`/`Glob`/`Agent` call** and, with
  its grep-blocking disabled, returned a bare `{"permission":"allow"}` — a pure no-op.
- **Zero analytics triggers across two full feature runs.**
- Every category it covered is already gated by a mechanical oracle in `npm run validate`
  (§3): `circular` → `depcruise no-circular`, `dead_code` → `knip`, `redundancy` → `jscpd`.
  Its own `circular` run here reported 7 cycles of which 2 were noise, and listed one real
  finding that was actually 13 instances.
- Two per-task tools checked against ground truth both failed: `constructors --struct
  TreeEntry` → *"No struct, class, or case-class named 'TreeEntry' found"* (blind to TS
  interfaces); `affected --files src/domain/storage/pack-writer.ts` → **258 test files**
  (no signal) that **omitted `pack-writer.test.ts`**, the file's own direct unit test.
- Its index was 2 days stale and answered normally without saying so; `tokensave doctor`
  rewrites `~/.claude/settings.json` unasked.

Removed: 3 global hook entries, 84 dead `mcp__tokensave__*` permission entries, ~501 MB.
Archive: `~/.claude/_removed-tokensave-2026-08-31/`.

## 7. Why this file is short now

Measured across two runs: **tool uptake tracks task need, not prompt shape.** A controlled
variation this run — restructuring one spawn to lead with the hard rule and bind serena to a
single named question — moved MCP uptake not at all, because that part had no barrel-reference
question to ask. The one agent that used serena was the one doing a gate-sweep, which
genuinely requires the one thing only serena does.

So the routing table was cut to the rows that name something **only one tool can do**. A menu
of options is not read; a rule tied to a question is. Do not re-grow this file into a catalogue.

## 8. Shared blind spot — the emit pipeline

All graph tools model **source**, not what `tsc` and the bundler do to it. `stripInternal: true`
in `tsconfig.build.json` erases an `@internal` declaration from the emitted `.d.ts` but leaves
an `export type { X } from './y.js'` re-export of it dangling, and `rollup-plugin-dts` fails
with `"X" is not exported by "y.ts"`. An `@internal` type therefore cannot be re-exported
through a facade. No graph query predicts this; `npm run build` is the only oracle.

Related: the `.d.ts` bundle shares a wireit script with the JS bundles, so a dts-only failure
is still labelled `[build:js]`. Read the rollup target header (`→ dist/types`), not the label.

## 9. Gate hygiene

- `npm run check:types` / `check:spelling` are **wireit-cached**; `Ran 0 scripts and skipped 1`
  reads exactly like a pass. Bypass with `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <files>`.
- **Never read a gate through a pipe** — `npm run validate | tail` reports exit 0 on a red run.
  Run gates bare into a file and `echo $?`.
- The **harness LSP is rooted at the main checkout**, not the worktree. Never gate on it and
  never source a review finding from it; `npx tsc --noEmit -p tsconfig.json` is the oracle.
  One run produced **four** distinct false-positive classes: ~30 phantom `Cannot find module`
  errors on untouched files; `'X' is declared but never read` for a symbol used 150 lines later;
  errors for a file that had already been deleted, twice; and `'best' is possibly 'undefined'` +
  `Unreachable code detected` captured mid-edit while an agent was deliberately mutating and
  restoring source to prove a test gap. The fourth is the dangerous one — semantic,
  line-specific, in a just-edited file, and indistinguishable from a real defect except that
  `tsc` was green and `git status` clean.
- **A green background job is not a green gate.** A command of the shape
  `npm run validate > f 2>&1; echo "EXIT=$?" >> f; echo done` makes the task notification report
  the *wrapper's* exit code — it said "exit code 0" twice while `VALIDATE_EXIT=1` sat in the
  file. Same class as `… | tail` masking, one layer up. Write the real exit code into the log
  and read it from there.
- macOS has **no `timeout(1)`** — a `timeout N …` probe exits 127 and proves nothing.
