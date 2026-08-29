# Spike — code-graph tool selection (graphify / codegraph / graft)

**Date:** 2026-08-29
**Question:** which of `graphify`, `codegraph`, `graft` best suits tsgit, given serena is already installed?
**Method:** all three installed into a sandboxed prefix and run for real against a clean clone of tsgit
(630 src files / 89k src LOC, 816 test files, 504k TS LOC, 1,239 md docs). No README-only claims.

**Verdict:** `graft`, deterministic tier only — but fix `tokensave` first.

---

## 0. The finding that reframes the question

Two code-reading MCP servers are already wired for this project: **serena** and **tokensave**.
`tokensave` is itself a code graph (39,896 nodes) exposing ~100 tools including
`callers`, `call_chain`, `impact`, `dead_code`, `circular`, `coupling`, `dsm`, `hotspots` —
i.e. most of what all three candidates sell.

It is also underperforming:

| probe | result |
|---|---|
| `tokensave_context("how does checkout read trees and write files…")` | **empty** — no entry points, no symbols, no code |
| `tokensave_search("checkout")` | correct, current (`checkout.ts:316`, real decl `:317`) |
| installed version | **7.0.2**, current is **7.10.0** (10 minor versions stale) |

The lexical layer works; the NL→graph layer returns nothing on this repo.
Adding a fourth code tool before resolving this buys an overlap, not a capability.

---

## 1. Measured results

Identical repo, identical query: *"how does checkout materialize blobs into the working directory"*.

| | graphify 0.9.51 | codegraph 1.6.0 | graft 0.15.0 |
|---|---|---|---|
| full index | 20.6s | **2.1s** (7.0s wall) | 21.3s |
| incremental (1 file) | n/a (see §3) | **0.52s** | 1.56s |
| nodes / edges | 14,845 / 51,019 | **23,622 / 164,863** | 11,609 / 36,631 |
| on-disk | 24 MB | 161 MB (single SQLite) | 84 MB |
| files parsed clean | 1716/1720 (**4 failed**) | 1696 indexed | **1682/1682** |
| answer cost | 1,624 tok | 6,274 tok | **322 tok** |
| answer correct? | **no** | mostly | **yes** |
| MCP tools added | many | **1** (`codegraph_explore`) | 6 |
| needs LLM key | yes (core value) | no | only `--deep` |
| licence | Apache-2.0 | MIT | MIT |
| telemetry | no | on by default | on by default |

Ground truth for the query: `checkout.ts:13` imports `materializeTree` from
`primitives/materialize-tree.ts`; blob writing lands in
`primitives/internal/write-working-tree-file.ts`.

- **graft** — returned `materializeTree` (`materialize-tree.ts:L235-L271`),
  `write-working-tree-file.ts`, `materialize-worktree-from-head.ts`, `walkWorkingTree`,
  `checkout:L317`. All correct. **322 tokens.**
- **codegraph** — found `materializeTree` / `planMaterialize`, plus a real blast radius with
  test mapping. Missed `write-working-tree-file.ts` and `walkWorkingTree`. 6,274 tokens.
- **graphify** — BFS seeded from `test-pyramid-budgets.json` and a `.properties.test.ts`,
  expanded to 415 nodes, truncated to 64, mostly `*.test.ts:L1`. **Never surfaced the answer.**

---

## 2. Shared blind spot — `export type *`

tsgit's public surface is barrels. All three fail on them:

```ts
// src/application/primitives/index.ts — 75 exports, 17 importers
export type * from './types.js';        // TS 5.0 syntax
// src/public-types.ts — the entire public type closure
export type * from './application/commands/index.js';
```

| tool | behaviour |
|---|---|
| graphify | **syntax error**, `no symbols extracted`, file silently dropped from the graph |
| codegraph | `0 symbols` **and falsely reports** `no other indexed file depends on it` |
| graft | `_No extracted symbols in this file._` |

Ground truth: `public-types.ts` is imported by `index.ts`, `index.node.ts`,
`index.browser.ts`, `index.default.ts`. codegraph's dependents claim is **wrong**, not merely absent.

None of the three resolves re-export chains. Barrel-shaped "who uses X" questions stay a
serena/grep job regardless of which is adopted.

---

## 3. Why graphify is out

- Python-first by design; TS rides an optional generic tree-sitter backend. It shows: the only
  tool that failed to parse tsgit source, and it failed on the two most central barrels.
- Ranked architectural hubs as `words` (1,189 edges) and `vitest` (845) alongside the genuine
  ones (`ObjectId`, `Context`, `writeObject`).
- Indexes `test-pyramid-budgets.json` as a graph node and seeds traversals from it.
- Core value (semantic extraction, community naming) is gated behind an LLM API key and spend.
- `graphify update . --code-only` → `error: unknown update option: --code-only`, though
  `extract` accepts it. The no-key incremental path is not wired.

---

## 4. graft — the cost

Install is broken on this machine, and it is not a sandbox artifact:

```
Error: No native build was found for platform=darwin arch=arm64 abi=127 … tree-sitter-kotlin
```

graft loads **all 23 grammars eagerly at startup**, so a missing prebuild for a language tsgit
does not use kills the whole CLI. The 11 native packages need install scripts, which **npm 12
(installed here: 12.0.2) denies by default** via `allowScripts`. Fix:

```bash
npm install-scripts approve tree-sitter tree-sitter-cli tree-sitter-go tree-sitter-java \
  tree-sitter-javascript tree-sitter-kotlin tree-sitter-php tree-sitter-python \
  @davisvaughan/tree-sitter-r tree-sitter-swift tree-sitter-typescript
npm rebuild            # ~30s, needs Xcode CLT
```

Also: telemetry is on by default (`graft telemetry disable`), and its output embeds an
instruction telling the agent to advertise its own token savings in the reply.

---

## 5. Why graft wins anyway

1. **Token economy is the binding constraint.** 322 vs 6,274 tokens for the same correct answer,
   across long craft-workflow runs on a 504k-LOC repo.
2. **`graft skeleton` fits how this library is navigated** — signatures + line ranges, full TS
   types, 77% cheaper than reading the file:
   ```
   graft skeleton src/application/primitives/materialize-tree.ts
   → 2,390 bytes vs 10,443 raw
   - L235-L271  function materializeTree  async (ctx: Context, opts: MaterializeTreeOpts) => Promise<MaterializeTreeResult>
   ```
3. **TS/JS is a full-fidelity tier** — hand-written extractor with scope-aware cross-file call and
   import resolution, not a generic grammar. Optional `graft build --lsp` adds compiler-grade
   edges via `typescript-language-server`. Only tool with **zero parse failures** on tsgit.
4. **Complements serena instead of duplicating it.** serena = precise LSP symbol ops and edits;
   graft = cheap ranked orientation + signatures. codegraph overlaps serena *and* tokensave harder.

**Do not run `graft build --deep`.** It generates LLM-written prose summaries per node. This repo
already carries 1,239 markdown docs / 267k lines, including ADRs that pin git-faithfulness. A
regenerated prose layer would be a second, drifting source of truth competing with the ADRs — and
it costs API spend. The `$0` deterministic tier is the part worth having.

---

## 6. The honest counter-case for codegraph

Pick codegraph instead if blast radius matters more than tokens:

- Best-engineered of the three: Rust kernel, 2.1s full index, **0.52s** incremental sync.
- Only **1 MCP tool** by default — the smallest context footprint, which matters with ~125 tool
  schemas already loaded across serena + tokensave.
- Uniquely returns symbol → callers → **owning tests** inline.

Its two disqualifying-in-context weaknesses: 161 MB of SQLite for this repo, and
`codegraph affected src/application/primitives/materialize-tree.ts` returned **139 of 816 test
files** (ground truth: 8 direct referencers). Too coarse to scope a Stryker run, which was the
main reason to want it here.

---

## 7. Recommendation

1. **Fix or drop `tokensave` first** — done, see §8.
2. **Then adopt `graft`**, deterministic tier only:
   ```bash
   npm i -g --allow-scripts=@nanonets/graft,tree-sitter,tree-sitter-cli,tree-sitter-go,\
   tree-sitter-java,tree-sitter-javascript,tree-sitter-kotlin,tree-sitter-php,\
   tree-sitter-python,@davisvaughan/tree-sitter-r,tree-sitter-swift,tree-sitter-typescript \
   @nanonets/graft
   cd tsgit && graft build && graft telemetry disable
   ```
   Skip `graft init`'s hook/statusline injection into `.claude/` unless the craft workflow is meant
   to depend on it. `graft/` is git-ignored automatically (appends 3 lines to `.gitignore`).

   `graft build` also **appends** a `!graft/` re-admit block to a root `.ignore` on every run, which
   puts 1,683 derived cards back into ripgrep's scope — 4,698 files searched instead of 3,015 (+56%).
   Deleting `.ignore` does not stick and editing it does not either (the append wins, last match
   first). Every hit in `graft/` duplicates one in `src/`, and a card left stale by a skipped build
   reads as a real hit. The exclusion is therefore pinned in a committed **`.rgignore`** — ripgrep
   gives it precedence over `.ignore`, and graft never writes it — with `/.ignore` git-ignored so
   graft's regeneration cannot dirty the tree.
3. **Keep serena as the editing and precise-reference tool.**
4. **Expect none of the graphs to answer barrel questions** (§2) — that is serena's job.

---

## 8. tokensave — root cause and fix (resolved)

The empty `tokensave_context` was not a bad query. The index was built on **schema v11** by
v7.0.2, while the extractor had moved to **v17**. The old schema extracted less than half the graph:

| | before | after `upgrade` + `sync --force` |
|---|---|---|
| version | 7.0.2 | 7.10.0 |
| nodes | 41,341 | **78,628** (+90%) |
| edges | 20,915 | **73,317** (+250%) |
| full sync age | **57 days** | current |
| tool permissions | **84 missing** | restored |
| DB | 56 MB | 260 MB |

Edges were fewer than nodes — a graph too sparse to traverse, which is exactly why `context`
found no entry points. After the fix the same query returns `readTree`, `resolveTreePath`,
`findTreeEntry`, `materializeWorktreeFromHead` and 9 more with `file:line`.

**Trap to remember:** a tokensave version bump implies a schema migration and a *full* re-index.
Incremental `sync` kept reporting success for 57 days against a half-built graph. Run
`tokensave doctor` after every upgrade.

---

## 9. How the three interoperate

They are not three of the same thing. They sit at different points on precision × cost.

```
                 cheap ─────────────────────────────────► expensive
  breadth   graft ask (322 tok)      tokensave context (~600 tok)
  shape     serena overview (275)    graft skeleton (2,075)      raw Read (12,617)
  precision                          serena find_symbol / find_referencing_symbols
  audit                              tokensave circular / god_class / coupling / dsm
```

Measured on `src/application/commands/rebase.ts` (1,254 lines, 50,654 bytes):

| view | cost | content |
|---|---|---|
| `serena get_symbols_overview` | ~1.1 KB | names grouped by kind, **no signatures, no lines** |
| `graft skeleton` | 8.6 KB | names + **full TS signatures** + line ranges |
| raw `Read` | 50.7 KB | everything |

serena's overview also mis-kinds arrow-function consts as `Constant` and `type` aliases as
`Variable`; graft prints the real declaration. Use overview to *decide*, skeleton to *work*.

### Routing table

| Task | Tool | Why |
|---|---|---|
| cold-start orientation, "how does X work" | **graft ask** | 322 tok, ranked, correct (§1) |
| file shape, cheapest possible | **serena `get_symbols_overview`** | names only |
| file shape + signatures | **graft skeleton** | 84% off raw, real TS types |
| who references X (exact, before editing) | **serena `find_referencing_symbols`** | per-file exact counts |
| anything crossing a barrel / `export type *` | **serena only** | graphs are blind (§2) |
| rename / replace a symbol body | **serena** | only one that writes safely |
| read one symbol's body | **serena `find_symbol`** | no whole-file read |
| type errors | **serena `get_diagnostics_for_file`** | LSP is ground truth |
| import cycles, god classes, coupling, DSM | **tokensave** | unique; found 7 real cycles |
| churn / blame / PR context | **tokensave** | git-aware graph |

### The loop

```
graft ask          → orient, get the 3-8 files that matter        (cheap, ranked)
graft skeleton     → shape of the one or two that matter          (signatures)
serena find_symbol → exact body / exact references                (precision)
serena replace_*   → edit                                          (safe write)
tokensave          → periodic architecture audit, NOT per-task    (analytics)
```

### Anti-patterns

- **Don't use `tokensave_context` for orientation.** Even fixed, it cost ~2× graft and still
  missed `materializeTree` on the checkout query.
- **Don't trust `tokensave dead_code` unfiltered** — 37,284 hits on this repo, including
  `describe(...)` blocks in test files. Scope it to `src/` or ignore it.
- **Don't ask graft or tokensave "who uses this barrel export"** — §2.
- **Don't run `graft build --deep`** — a drifting LLM prose layer competing with the ADRs.
- **Don't re-run a full `tokensave sync --force` per task** — 7.2s and 260 MB; the installed
  PreToolUse/Stop hooks keep it incremental.

### Staleness contract

| tool | freshness | cost to refresh | guard |
|---|---|---|---|
| serena | always live (LSP) | none | none needed |
| graft | file cache | `graft build` 1.56s incremental | `graft check` (CI-friendly) |
| tokensave | SQLite + hooks | `sync` 7.2s, full re-index on schema bump | `tokensave doctor` |

### Open finding — import cycles (triaged 2026-08-29)

`tokensave circular` reported **7**. Hand-verified against the source: **5 real, 1 false
positive, 1 bogus.**

| # | cycle | verdict |
|---|---|---|
| 1 | `domain/commands/config-key` → `commands/error` → `domain/error` →(type) `commands/error` | real, type-only leg |
| 2 | `domain/storage/pack-order` ⇄ `pack-writer` | real, type-only leg |
| 3 | 88 files spanning adapters→commands→primitives→domain→transport→**test** | **bogus** — an SCC dumped in alphabetical order, not a path |
| 4 | `primitives/bisect-midpoint` ⇄ `domain/commit/binary-heap` | **false positive** — no reverse edge exists |
| 5 | `commands/name-rev` ⇄ `internal/name-rev-options` | real, type-only leg |
| 6 | `commands/describe` ⇄ `internal/describe-options` | real, type-only leg |
| 7 | `repository.ts` ⇄ `repository/layout-roots` | real, type-only leg |

All five real cycles are the **same shape** — a value import one way, `import type` back:

```ts
// commands/name-rev.ts
import { parseNameRevOptions } from './internal/name-rev-options.js';   // value
// commands/internal/name-rev-options.ts
import type { NameRevOptions } from '../name-rev.js';                   // type — erased
```

`import type` is erased at build, so **none of these is a runtime cycle**. They are the
"options type lives with the command, parser lives in `internal/`" pattern. The only thing
they cost is the layering claim in `CLAUDE.md`.

If they are to be removed, the fix is uniform and mechanical: relocate the shared option type
into the `internal/` module (or a third module) and have the command import it from there,
inverting the back-edge. Five sites, behaviour-preserving, type-check is the gate.

**Do not trust the raw `cycle_count`** — 2 of 7 were noise, and the tool cannot distinguish a
type-only edge from a value edge. Verify every cycle before acting.
