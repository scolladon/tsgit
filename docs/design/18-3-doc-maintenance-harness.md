# Design — Doc-maintenance harness (Phase 18.3)

**Status:** Draft.

Backlog: **18.3** — _"Doc-maintenance harness — automated drift detection so the new structure doesn't rot."_

Follow-up to **18.2** (`docs/design/18-2-audience-first-doc-restructure.md`). 18.2 landed the three-funnel layout (`docs/get-started/`, `docs/use/`, `docs/understand/`) and per-file command/primitive pages under `docs/use/{commands,primitives}/`. 18.3 keeps it from rotting.

## 1. Goal

Four automated drift-detection mechanisms in CI. Each independently testable, each producing an actionable failure message, each invocable locally where it makes sense.

| # | Mechanism | What rots without it |
|---|---|---|
| 1 | Markdown link checker | Internal cross-links break silently when files move; external citations 404 unnoticed. |
| 2 | API coverage drift | A new command lands in `repo.*` with no corresponding `docs/use/commands/<kebab>.md`. |
| 3 | TypeDoc drift | JSDoc on the public surface drifts out of sync with code; no in-repo proof that the API report is current. |
| 4 | Path-based docs PR gate | `src/application/{commands,primitives}/<name>.ts` changes ship without a matching docs update. |

Non-goals (this phase):

- Style enforcement (table column counts, section order, singular/plural conventions). Per-PR review keeps this.
- Auto-generation of API docs from source. Drift detection only — generation stays the author's job.
- Same-file anchor checks. Rare in practice; per-PR review handles.
- Convention enforcement on `docs/get-started/` and `docs/understand/`. Only `docs/use/` is structurally regular enough to gate.

## 2. Mechanism 1 — Markdown link checker

### 2.1 Tool choice

[**lychee**](https://github.com/lycheeverse/lychee) (Rust, single binary, official GitHub Action). ADR-095 captures the comparison.

Reasons over `markdown-link-check`:
- 10–50× faster on a doc tree this size (single-binary, parallel by default)
- Fewer false positives on rate-limited hosts (built-in retry, exponential back-off, `--accept` status-code list)
- TOML config file co-located with the repo — explicit allowlists / excludes survive in git
- Single-file action (`lycheeverse/lychee-action`) — no Node install step needed in the CI job

### 2.2 Scope

Files checked: `README.md`, `CONTRIBUTING.md`, `RUNBOOK.md`, `SECURITY.md`, and every `.md` under `docs/` **except** the historical artifacts listed below.

Files excluded:
- `docs/plan/*.md` — per-phase plans frozen at land time; reference files that no longer exist (e.g. `DESIGN.md`, `MIGRATION.md`)
- `docs/spike/*.md` — research notes, frozen at land time, frequently reference exploratory paths
- `docs/design/phase-13-4b-*.md` — the single design doc 18.2's restructure invalidated; rewriting it would be lying about history

These exclusions live in `.lychee.toml` under `exclude_path`.

### 2.3 Behaviour

- Internal links (`./foo.md`, `../bar/baz.md`) — checked strictly. Broken file references fail the job.
- Anchor fragments (`./foo.md#section`, `#section`) — **not checked** in this phase. Lychee runs without `--include-fragments`. Per-PR review handles anchor stability; heading-text churn breaks anchors without renaming files, which would generate too much noise to bound usefully at the gate.
- External URLs (`https://…`) — checked with `--timeout 20`, `--max-retries 2`, exponential backoff. The `accept` list covers known-rate-limited responses (`200..=299, 429`).
- `mailto:` / `tel:` / `file:` schemes — skipped (`scheme = ["http", "https"]`).

### 2.4 Local invocation

`npm run check:doc-links` — runs `lychee` directly via the local binary, picking up `.lychee.toml` from the repo root. Lychee is Rust, distributed as a single binary; contributors install it once (`brew install lychee`, `cargo install lychee`, or a release tarball) — `CONTRIBUTING.md` adds a one-line note pointing at the upstream README.

If `lychee` is missing, the npm script exits non-zero with the install hint in `stderr`. We deliberately do **not** silently skip — a contributor who can't reproduce a CI failure locally is a contributor who pushes the same broken link twice.

Wireit recipe declares `.lychee.toml` + the `.md` files in scope as inputs, so re-runs are cached cleanly.

### 2.5 Failure messages

Lychee emits one stanza per broken link with the source file, line number, target URL, and HTTP status / parse error. Example:

```
✗ README.md:42 -> ./docs/get-started/node.md (status: NotFound)
```

No further enrichment needed — the line is enough to open the file and fix.

## 3. Mechanism 2 — API coverage drift

### 3.1 Source of truth

The canonical surface enumeration is the `Repository` interface in `src/repository.ts` — every `repo.<command>` and `repo.primitives.<primitive>` binding the user touches lives there. Walking the index files (`src/index.{node,browser,default}.ts`) would double-count adapter detection logic and miss nothing the `Repository` interface doesn't already enumerate. ADR-096 records this pivot from the original backlog wording.

The check parses `src/repository.ts` for two member sets:
- Top-level `readonly <name>: ...` declarations inside `interface Repository { ... }` — minus the `primitives` and `ctx` and `dispose` members which are not surface commands
- Top-level `readonly <name>: ...` declarations inside the `primitives:` nested type

### 3.2 Required artifacts per name

For each `<camelCase>` extracted:
1. Convert to kebab-case (`catFile` → `cat-file`, `revParse` → `rev-parse`, etc.)
2. Require: `docs/use/<kind>/<kebab>.md` exists (`<kind>` is `commands` or `primitives`)
3. Require: `docs/use/<kind>/README.md` index table contains a row with link text matching the camelCase name (e.g. `` [`catFile`](cat-file.md) ``)

### 3.3 Implementation

`scripts/check-doc-coverage.ts` — a pure Node script using `node --experimental-strip-types`. No ts-node, no compiled build.

Parsing strategy: **regex-based, not TypeScript-AST-based**. The `Repository` interface follows a strict shape (`readonly <name>: BindCtx<...>` lines indented inside `interface Repository { ... }` and `primitives: { ... }`). A regex with anchors is sufficient and avoids pulling `typescript` as a script-time dependency (knip would complain). ADR-097 captures the trade-off.

```ts
// Pseudocode
const source = await readFile('src/repository.ts', 'utf8');
const commandRe = /^  readonly (\w+):\s*BindCtx</gm;
const primitiveRe = /^    readonly (\w+):\s*BindCtx</gm;
```

The script reports every gap with a structured failure stanza:

```
ERROR docs/use/commands/<kebab>.md missing
  Surface symbol: repo.<camelCase>  (src/repository.ts:NNN)
  Expected file:  docs/use/commands/<kebab>.md
  Expected index entry in docs/use/commands/README.md:
    | [`<camelCase>`](<kebab>.md) | <one-line summary> |

ERROR docs/use/commands/README.md missing index row for `<camelCase>`
  Add a row that links to docs/use/commands/<kebab>.md.
```

Exit codes: `0` = clean, `1` = at least one gap (each gap printed; the script does not short-circuit on the first error so multiple gaps surface in one run).

### 3.4 Local invocation

`npm run check:doc-coverage`.

Wireit declares `src/repository.ts` and the `docs/use/{commands,primitives}/` trees as inputs; cached on identity, instant on no-op re-runs.

### 3.5 Allowlist

A small JSON allowlist (`scripts/check-doc-coverage.allowlist.json`) holds names that intentionally have no per-file page. Empty at land time (`{ "commands": [], "primitives": [] }`) — added only with an explicit comment recording **why** (e.g. an internals-only re-export). This keeps the suppression visible and grep-able.

## 4. Mechanism 3 — TypeDoc drift

### 4.1 Approach

The committed source of truth is **a JSON snapshot** at `reports/api.json`, not the rendered HTML tree at `reports/api/`. ADR-098 records this pivot from the original "directory" wording.

Reasons over committing `reports/api/`:
- TypeDoc emits 100+ HTML files for a surface this size. Every JSDoc tweak generates a wall of `.html` diffs that drown the meaningful change.
- JSON is one file (~hundreds of KB), structurally diffable — a renamed parameter or missing summary shows clearly.
- HTML continues to render from the same source for the gh-pages site via the existing `typedoc` invocation. We don't lose anything.

### 4.2 Behaviour

`npm run docs:json` — emits `reports/api.json` via `typedoc --json reports/api.json --emit none`.

CI job:
1. Run `npm run docs:json`
2. `git diff --exit-code reports/api.json` — exits non-zero if regenerated JSON differs from committed.

The failure stanza is the `git diff` output itself. A maintainer who sees the diff knows exactly what JSDoc to update (or, if the change is intentional, commits the new `reports/api.json`).

### 4.3 Committing the snapshot

`reports/api.json` lands in 18.3's PR, generated against the head of `main` at branch time. From then on every PR includes its updated copy. Subsequent PRs that touch JSDoc must commit the regenerated snapshot or fail this job.

This means the file becomes a routine touchpoint — like `package-lock.json`. Reviewers should glance at it; CI guarantees its currency.

### 4.4 Local invocation

`npm run check:doc-typedoc` — composes `docs:json` + the diff step, so a contributor sees the same result CI does. If they didn't commit the regenerated file, the script reminds them with a one-line message.

## 5. Mechanism 4 — Path-based docs PR gate

### 5.1 Scope

Triggers on pull requests only. When the changeset touches `src/application/commands/<name>.ts` or `src/application/primitives/<name>.ts`, the same PR must also touch one of:
- `docs/use/commands/<kebab>.md` (or `docs/use/primitives/<kebab>.md`)
- `docs/use/commands/README.md` (or `docs/use/primitives/README.md`)

Any one is sufficient — a rename or a major API change typically touches both, but the gate accepts either.

### 5.2 Warn-vs-block

**Warn-only at land time.** Promoted to a blocking gate after one cycle of real-PR tuning (ADR-099). The first iteration writes a step-summary annotation and a PR comment; never `exit 1`.

Rationale:
- A new check that immediately blocks every PR teaches contributors to find a workaround. Warn-only lets the signal accumulate while the rules stabilise.
- 18.2's restructure changed naming conventions; PRs already in flight may legitimately not match the rule. A cycle of observation surfaces the edge cases (rename PRs, deletions, partial-rollouts).
- Promotion is a one-line change (remove `continue-on-error: true`) — cheap to reverse, cheap to flip.

The PR comment template:

```
## 📝 Docs drift — informational only

The following commands/primitives changed in this PR without a matching
`docs/use/*` update. After one cycle of tuning this gate will start blocking;
please consider adding the docs update in the same PR.

- `src/application/commands/<name>.ts` → expected `docs/use/commands/<kebab>.md`
  or a row update in `docs/use/commands/README.md`
- ...

(Suppressing this comment: skip if the change is intentionally code-only —
type-only refactor, internal-only signature change, etc. The blocking phase
will add an explicit `[skip-docs-gate]` PR-label escape hatch.)
```

### 5.3 Implementation

In-job script using `gh api` or `git diff --name-only <base>...<head>`. No third-party `actions/changed-files`-style dependency — the logic is small enough to inline and the supply-chain footprint is one less thing to audit.

PR-only — no `npm` script. The check is meaningless outside the `pull_request` event (there is no base to diff against in local development; `npm run validate` covers everything else).

## 6. CI job layout

Four jobs, all on `ubuntu-latest`, all gated on `lint + typecheck` (or no gating at all for `docs-pr-gate` which is pure metadata).

```
doc-links        — needs: lint, typecheck     ~15-30s
doc-coverage     — needs: lint, typecheck     ~5s
doc-typedoc      — needs: lint, typecheck     ~30s
docs-pr-gate     — pull_request only          ~5s
```

Total wall-time on a clean PR: under 90s, well under the 90s budget called out in the brief.

The jobs run in parallel with each other and with the existing static-analysis stage. They do not depend on `build`, `test:unit`, or anything heavier; a doc-only PR clears in ~30s.

## 7. Failure mode map

| Failure | Mitigation |
|---|---|
| Lychee rate-limits external URLs (GitHub anchors, npm pages) | `.lychee.toml` `accept = [200, 206, 301..=308, 429]` + per-host retry. Known-flaky hosts (`npmjs.com`, `archlinux.org`) listed in the config's `accept` block. |
| `actions/checkout` flakes once (`could not read Username`) | Same retry advice as 18.2: `gh run rerun --failed` before debugging. No structural mitigation needed. |
| `reports/api.json` non-determinism across runners (path ordering, timestamps) | TypeDoc's JSON output is deterministic given identical sources; we pin `typedoc` to a single version in `package.json`. The CI job runs the same Node version as `npm run docs:json` locally — no divergence vector. If we see flakes anyway, normalise the JSON with a small sort pass (deferred until observed). |
| `scripts/check-doc-coverage.ts` regex misses a name (false negative) | Regex anchored to `^  readonly (\w+): BindCtx<` — a maintainer renaming `BindCtx` will see the script return "no commands found" and the test (Section 9) will fail. The test asserts the parsed list against an explicit expected count derived from `Repository`. |
| `scripts/check-doc-coverage.ts` regex falsely matches (false positive) | Same regex anchoring + the explicit allowlist mechanism. A name added to the interface but not yet documented surfaces immediately — the path-based gate redundantly catches it. |
| Path-based gate trips on intentional code-only refactors (type tightening, internal rename) | Warn-only at land time. Promotion ADR will define an escape hatch (PR label) before the gate blocks. |
| `npm run check:doc-typedoc` produces a noisy diff on a JSDoc-only PR | That's the design. Reviewers see the diff, confirm it matches the JSDoc change, commit it. The noise is the signal. |

## 8. Out of scope (explicit)

- Diátaxis category enforcement on individual pages (page-shape lints)
- Heading-anchor stability across PRs (the link checker covers external/internal-file references; per-PR review catches anchor renames)
- TypeDoc HTML diffing (replaced by JSON; HTML continues to render via the existing `typedoc` invocation, untouched)
- Versioned doc snapshots per release (release-please owns CHANGELOG; doc evolves on `main`)

## 9. Test strategy

Three of the four mechanisms ship with unit tests; the fourth (path-based PR gate) is a CI-only check exercised by integration via PRs to this branch.

- **`scripts/check-doc-coverage.ts`** — `test/unit/scripts/check-doc-coverage.test.ts`
  - Given a synthetic repository.ts string with N commands + M primitives, when parsed, then the parser yields exactly those names
  - Given a docs tree missing one entry, when the checker runs against the synthetic parse, then exits 1 with the missing entry in stderr
  - Given an index README missing one row, when the checker runs, then exits 1 with the missing row reported
  - Given the allowlist contains a name, when that name has no per-file page, then exits 0
- **`scripts/check-doc-coverage.ts`** integration test runs against the real `src/repository.ts` and the real docs tree at land time; must exit 0.
- **TypeDoc JSON snapshot** — no Vitest test; the CI job is the test. A local re-run after a code change demonstrates the diff path.
- **Link checker** — no Vitest test; lychee owns its own. We exercise the config via the CI job.
- **Path-based PR gate** — exercised by the branch's own PR (which touches commands or primitives only if absolutely necessary — this PR adds docs + CI only and should not trip its own gate). Real PRs in following weeks provide the tuning signal.

## 10. ADRs landed with this design

- **ADR-095** — Markdown link checker tool (lychee over markdown-link-check)
- **ADR-096** — API drift source-of-truth: parse `src/repository.ts` Repository interface (not the per-runtime `index.*.ts` exports)
- **ADR-097** — API drift parser: regex over TypeScript-AST
- **ADR-098** — TypeDoc drift snapshot format: JSON over HTML directory
- **ADR-099** — Path-based docs PR gate: warn-then-block ramp

## 11. Plan

See `docs/plan/18-3-doc-maintenance-harness.md` (next).
