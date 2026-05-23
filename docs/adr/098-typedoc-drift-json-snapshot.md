# ADR-098: TypeDoc drift snapshot — JSON over HTML directory

## Status

Accepted (at `5cb6a6b`)

## Context

Phase 18.3 needs a CI gate that detects JSDoc drift on the public surface. The backlog's wording was *"regenerated `reports/api/` must equal committed; CI fails on diff"* — i.e. commit the rendered HTML directory and diff it.

`reports/api/` rendered HTML for a surface this size contains 100+ files (one per class, interface, function, type alias, plus an index, assets, navigation JS, etc.). A single JSDoc comment change cascades into many HTML diffs (`hierarchy.html`, the changed page itself, search-index assets that include the changed text, sibling pages whose nav blocks re-render).

TypeDoc also emits a structured **JSON** representation of the same data via `--json <path>` (and `--emit none` to skip HTML). A single file. Deterministic given fixed inputs. Diffs are structurally legible — a renamed parameter shows as one or two changed lines, not 30 HTML diffs.

## Decision

Commit a single `reports/api.json` file as the drift baseline. CI regenerates it via `typedoc --json reports/api.json --emit none` and runs `git diff --exit-code reports/api.json`.

The HTML output (`reports/api/`) continues to be generated for the gh-pages site by the existing `typedoc` invocation. It is **not** committed; it remains a CI build artifact.

`npm run docs:json` is the new wireit recipe that produces the snapshot. `npm run docs` (HTML) is unchanged.

## Consequences

### Positive

- **Signal-to-noise ratio is high.** A reviewer sees one JSON diff that maps cleanly to the JSDoc change. No HTML rerender noise.
- **One file, not a directory.** History stays clean — `git log reports/api.json` shows API surface changes as legible per-PR diffs.
- **Deterministic.** TypeDoc's JSON output is stable across runs given a fixed source tree and pinned `typedoc` version (both already pinned in `package.json`).
- **HTML for users, JSON for CI.** The two outputs serve their intended audiences — HTML for the gh-pages reader, JSON for the diff machinery.

### Negative

- **File size.** The JSON snapshot is a few hundred KB to low single-digit MB depending on JSDoc density. Acceptable in git, much smaller than the rendered HTML directory would be.
- **Updating the snapshot is a per-PR ritual.** A contributor who changes JSDoc must run `npm run check:doc-typedoc`, commit the regenerated file, and push. Failure mode if forgotten: CI fails with a clear `git diff` output pointing at the file. The local script tells them what to do.
- **TypeDoc-version coupling.** Bumping `typedoc` will regenerate the snapshot wholesale (formatting, IDs may shift). Dependabot PRs for `typedoc` will commit the new baseline along with the bump — standard tooling-update pattern.

### Neutral

- If TypeDoc JSON ever proves non-deterministic across runners (sort order, abs path leakage), we add a `scripts/normalise-typedoc-json.ts` post-processing step. Deferred until observed; current evidence says output is stable.
- The "one big JSON file" pattern shows up in two other tooling families we already use (`package-lock.json`, `tsconfig.tsbuildinfo`) — contributors will recognise the workflow.
