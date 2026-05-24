# Phase 19.4 — Integration-test usefulness audit

Wave 0 (test base) continuation. 19.1 hardened mutation feedback; 19.2 counted
the pyramid; 19.3 hardened unit-test expressiveness. 19.4 turns the same lens on
the **integration** tier: what does each file *prove* that no unit test can,
and is it the only one proving it?

This is a tooling-and-observability phase. No product code changes. The output
is: (a) a machine-readable `@proves` header on every integration test file,
(b) a new audit heuristic in `tooling/audit-test-pyramid.ts` that validates the
headers and flags duplicates / unclassified files, (c) a sweep that retrofits
all 21 current integration files, (d) a `surfaces.json` index derived from the
headers so 19.5a (browser surface-parity audit) can consume it.

## 1. Goals

1. **Every integration test file states what it proves.** Reviewers, future
   contributors, and downstream tooling all read the same place: a small
   structured header block at the top of the file.
2. **Duplicates surface as concrete findings.** Two integration files claiming
   the same `(surface, bucket)` pair → audit finding; one of them is either
   over-coverage or mis-bucketed.
3. **Orphans become first-class.** An integration test today is "orphan" if
   its surface name does not match anything else in the tree. 19.4 doesn't
   *promote* the test — it *names* the surface so 19.5a can promote it into
   the browser-surface-parity matrix.
4. **Single source of truth for the integration tier.** The audit emits
   `reports/integration-surfaces.json` listing every `(file, surface, bucket,
   unique)` tuple. 19.5a will read this to compute browser-coverage gaps.

## 2. Non-goals

- **No new integration tests.** This phase audits and documents; it does not
  add coverage. Net-new tests for gaps surfaced by the audit are 19.5/19.5a
  (browser surface parity) or follow-up tickets.
- **No CI gate at land time.** Per [ADR-125](../adr/125-integration-audit-gating-posture.md)
  the new `integrationProof` heuristic ships in `report-only` until one merge
  cycle confirms the sweep stays clean. Same pattern as ADR-099 / ADR-104 /
  ADR-114.
- **No unit-test changes.** The audit's classification (per ADR-105) already
  separates units from integrations by directory; this phase doesn't touch the
  unit tier.
- **No deletion of "duplicate" files.** If the audit flags an overlap, the
  resolution is a follow-up decision (merge files, rebucket, or accept the
  overlap and split the surface). The audit only surfaces the candidate.
- **No surface-name validation against `src/repository.ts`.** Surfaces include
  non-porcelain paths (`nodeShim`, `nodeFs.chmod`, `memory.indexRoundtrip`) so
  binding the namespace to `repo.*` would over-constrain. Validation is purely
  syntactic (see §5.1).

## 3. The `@proves` header — grammar

Per [ADR-121](../adr/121-integration-proves-header-grammar.md), every file
under the integration glob carries a top-of-file JSDoc block with **exactly
one** `@proves` directive followed by three required keys (no extras). The
block may include any amount of free-form prose before or after the directive.

```ts
/**
 * <free-form prose — what the file does in human terms>
 *
 * @proves
 *   surface:  <kebab-or-camel-case identifier, e.g. clone | sparseCheckout | nodeFs.chmod>
 *   bucket:   <one of the 7 bucket values — see §4>
 *   unique:   <one sentence — what only this tier can prove>
 */
```

Parser rules:

- Header block must start at byte 0 (only a shebang line is permitted before it).
- The `@proves` token sits on its own line inside the JSDoc.
- Each key is on its own line; whitespace before/after the colon is flexible
  but the key name itself is exact (`surface`, `bucket`, `unique`).
- `surface` matches `^[a-z][a-zA-Z0-9.-]{1,40}$` (camelCase or kebab, dot
  segments allowed for sub-surfaces).
- `bucket` must equal one of the seven enum values (§4).
- `unique` is free-form text, ≥ 12 characters, ≤ 200 characters, single line.

Why JSDoc and not a sidecar JSON file: the prose and the structured keys
travel together in code review; nobody opens a separate file to check the
"why" before approving an integration test.

## 4. Bucket taxonomy

Per [ADR-122](../adr/122-integration-bucket-taxonomy.md), every integration
file MUST justify its existence by claiming exactly one of these buckets:

| Bucket | What it proves | Example |
|---|---|---|
| `real-fs` | Real Node `fs` — POSIX/NTFS semantics units cannot fake. | `node-fs-mode-bits.test.ts` |
| `real-http` | Real HTTP socket against canonical `git-http-backend`. | `clone-http-backend.test.ts` |
| `real-process` | Real subprocess — `child_process.spawn` against canonical `git`. | `node-hook-runner.test.ts` |
| `cross-tool-interop` | Round-trip against canonical `git` (file format on disk). | `reflog-writers.test.ts` |
| `platform-only` | Behaviour that exists on one OS only and would `skipIf` everywhere else in the unit suite. | `node-fs-real-symlinks.test.ts` |
| `multi-adapter-parity` | End-to-end flow exercised through the memory adapter to lock down domain/adapter composition. | `adapter-domain-interop.test.ts`, `sparse-checkout.test.ts` |
| `coverage-gap` | Code path the unit suite *cannot* reach (e.g. the Node runtime shim that builds the adapters). | `node-shim.test.ts` |

Buckets `real-fs`, `real-http`, `real-process`, `platform-only` MUST live
under one of the directory globs that vitest already segregates (per
`vitest.config.ts` projects): `network/`, `posix-only/`, `win-only/`. The
audit cross-checks the directory against the bucket; a mismatch is a finding.

The remaining three (`cross-tool-interop`, `multi-adapter-parity`,
`coverage-gap`) live at the integration root.

Two buckets exist because they look superficially identical but justify the
file very differently: `multi-adapter-parity` proves *our* composition;
`cross-tool-interop` proves *git's* compatibility. The audit treats them as
disjoint for duplicate detection (§5.2).

## 5. Audit heuristic

Per [ADR-124](../adr/124-integration-usefulness-heuristic-shape.md), the new
heuristic key `integrationProof` produces three classes of finding, returned
as separate counters in `reports/test-pyramid.json` so a reviewer can act on
each independently.

### 5.1 Missing or malformed header (`missing`)

For every file matching the integration glob (mainline + `posix-only` +
`win-only` + `network/`):

- File header doesn't contain a `@proves` block → finding.
- Block missing one of `surface` / `bucket` / `unique` → finding.
- `surface` fails the regex → finding.
- `bucket` is not in the enum → finding.
- `unique` is < 12 or > 200 chars, or multiline → finding.

### 5.2 Duplicate proof (`duplicate`)

Per [ADR-123](../adr/123-integration-duplicate-detection.md), for every
`(surface, bucket)` pair claimed by two or more files:

- If at least one of the files is in a platform-only directory
  (`posix-only/` or `win-only/`) AND the bucket is `platform-only`, the
  overlap is expected (POSIX vs Windows partition the same surface) →
  not a finding.
- Otherwise → finding listing both file paths.

Rationale: `posix-only/node-fs-real-symlinks.test.ts` and (a hypothetical)
`win-only/node-fs-junctions.test.ts` would both claim `surface: nodeFs.links`
+ `bucket: platform-only` — that's intended, not a duplicate. But two files
claiming `surface: clone` + `bucket: real-http` overlap genuinely.

### 5.3 Bucket-directory mismatch (`misplaced`)

- `bucket` is `real-http` but file is not under `network/` → finding.
- `bucket` is `platform-only` but file is not under `posix-only/` or
  `win-only/` → finding.
- `bucket` is `real-process` and file is not under `posix-only/` or
  `win-only/` → finding.
- `bucket` is `cross-tool-interop` / `multi-adapter-parity` / `coverage-gap`
  and file is NOT at integration root → finding.
- `bucket` is `real-fs` — no directory rule. May live at root (OS-agnostic
  end-to-end against a real tmpdir, e.g. `submodules.test.ts`) or under
  `posix-only/` / `win-only/` if it happens to also be OS-segregated for
  unrelated reasons.

This catches the easy class of error where a developer adds a
`real-http`-bucketed file outside `network/` (and thereby outside the network
CI job's matrix slice).

### 5.4 Output

`reports/test-pyramid.json` gains an `integrationProof` field:

```jsonc
{
  "integrationProof": {
    "missing":   [{ "path": "...", "reason": "no @proves block" }, ...],
    "duplicate": [{ "surface": "...", "bucket": "...", "paths": [...] }, ...],
    "misplaced": [{ "path": "...", "bucket": "...", "expected": "..." }, ...]
  }
}
```

The audit also writes `reports/integration-surfaces.json` (the orphan-promotion
artefact for 19.5a):

```jsonc
{
  "files": [
    {
      "path": "test/integration/network/clone-http-backend.test.ts",
      "surface": "clone",
      "bucket": "real-http",
      "unique": "smart-HTTP v1 packfile fetch against canonical git-http-backend"
    },
    ...
  ]
}
```

19.5a reads this to compute "commands with integration coverage but no
browser-tier coverage" — that's the gap report it owes.

## 6. Manifest changes

`test-pyramid-budgets.json` gains a new heuristic block:

```jsonc
"integrationProof": {
  "tier": "integration",
  "buckets": [
    "real-fs", "real-http", "real-process",
    "cross-tool-interop", "platform-only",
    "multi-adapter-parity", "coverage-gap"
  ],
  "surfaceRegex": "^[a-z][a-zA-Z0-9.-]{1,40}$",
  "uniqueMinLength": 12,
  "uniqueMaxLength": 200,
  "directoryRules": {
    "real-http":            ["network/"],
    "real-fs":              ["root", "posix-only/", "win-only/"],
    "real-process":         ["posix-only/", "win-only/"],
    "platform-only":        ["posix-only/", "win-only/"],
    "cross-tool-interop":   ["root"],
    "multi-adapter-parity": ["root"],
    "coverage-gap":         ["root"]
  }
}
```

`gating.integrationProof` defaults to `false` for the sweep PR. A follow-up
PR (after one observation cycle, per ADR-125) flips it to `true`.

The schema (`tooling/test-pyramid-budgets-schema.json`) gains the
`integrationProof` definition and adds it to the required `heuristics` keys.
`parseManifest` learns to validate `buckets` is non-empty + unique and that
`directoryRules` keys equal `buckets`.

## 7. Scanner module — `parse-proves-header.ts`

A new file under `tooling/test-pyramid/`:

```ts
export interface ProvesHeader {
  readonly surface: string;
  readonly bucket: string;
  readonly unique: string;
}

export interface ProvesError {
  readonly reason:
    | 'no-jsdoc-at-top'
    | 'no-proves-block'
    | 'missing-key'
    | 'bad-surface'
    | 'bad-bucket'
    | 'bad-unique';
  readonly detail?: string;
}

export type ProvesResult =
  | { readonly ok: true; readonly header: ProvesHeader }
  | { readonly ok: false; readonly error: ProvesError };

export const parseProvesHeader = (
  source: string,
  config: IntegrationProofHeuristic,
): ProvesResult => ...;
```

Implementation: pure-string parser (no AST), in the spirit of ADR-097. Steps:

1. Normalise line endings (`\r\n` → `\n`) before tokenising so the parser
   behaves identically on Windows-checkout runners.
2. Skip an optional shebang line.
3. Match the first `/**` and find its closing `*/`.
4. Inside that span, find a line whose trimmed-stripped (`* `) form starts
   with `@proves`.
5. Walk forward from there, parsing `key: value` lines until either a blank
   `*` line or the closing `*/`.
6. Validate the three keys against the heuristic config.

Edge cases the unit tests must cover:
- File starts with shebang then JSDoc → parsed.
- File starts with a single-line `//` comment then JSDoc → no-jsdoc-at-top.
- JSDoc present but contains no `@proves` → no-proves-block.
- `@proves` present but only two of three keys → missing-key.
- `surface` violates regex → bad-surface.
- `bucket` not in enum → bad-bucket.
- `unique` too short / too long / contains `\n` → bad-unique.

## 8. New detector — `detect-integration-proof.ts`

Mirrors the existing `detect-*.ts` files in `tooling/test-pyramid/`:

```ts
export const detectIntegrationProof = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): IntegrationProofFindings => ...;
```

Steps:

1. Filter `files` to the integration tier via `classifyTestFile`.
2. For each file, call `parseProvesHeader`. Push errors to `missing`.
3. For successful parses, compute the file's directory class
   (`network`/`posix-only`/`win-only`/`root`). Cross-check against the
   bucket's directory rule. Push mismatches to `misplaced`.
4. Group successful parses by `(surface, bucket)`. For each group with
   `size >= 2`, apply the platform-only exemption (§5.2). Push remaining
   groups to `duplicate`.

The detector returns `{ missing, duplicate, misplaced }`. The render layer
joins them into one heuristic block in the markdown output and one structured
field in JSON.

## 9. Tooling wiring

- `tooling/audit-test-pyramid.ts` imports the new detector, calls it on the
  full `files` array (not filtered, since the detector does its own
  classification), and merges the result into `outcome.findings`.
- `outcome` gains `integrationProof: IntegrationProofFindings`. The
  `FINDING_KEY_BY_GATING` map gets the new entry.
- `render-report.ts` gains a section "Integration usefulness" with three
  sub-tables.
- `writeReports` writes the new sidecar `reports/integration-surfaces.json`
  whose content is derived from the successful parses (so it stays in sync
  with whatever the audit accepts).

## 10. Sweep — retrofitting the 21 existing files

Per [ADR-126](../adr/126-integration-proves-sweep-policy.md), the sweep
amends each file's existing JSDoc block (a pre-flight `head -n 1` confirmed
that all 21 current integration files already open with `/**`):

- Keep the existing prose verbatim.
- Append the `@proves` directive followed by the three keys.
- No reformatting of the prose, no rewording, no rewrap. The audit cares
  only about the structured block.

Bucket/surface mapping at land time:

| File | Surface | Bucket |
|---|---|---|
| `adapter-domain-interop.test.ts` | `memory.objectRoundtrip` | `multi-adapter-parity` |
| `add-all.test.ts` | `addAll` | `multi-adapter-parity` |
| `gitignore-end-to-end.test.ts` | `gitignore` | `multi-adapter-parity` |
| `node-shim.test.ts` | `nodeShim` | `coverage-gap` |
| `reflog-writers.test.ts` | `reflog` | `cross-tool-interop` |
| `sparse-checkout.test.ts` | `sparseCheckout` | `multi-adapter-parity` |
| `sparse-reset-merge.test.ts` | `sparseResetMerge` | `multi-adapter-parity` |
| `submodules.test.ts` | `submodules.walk` | `real-fs` |
| `network/cat-file-batch-promisor.test.ts` | `catFile.promisor` | `real-http` |
| `network/clone-http-backend.test.ts` | `clone` | `real-http` |
| `network/fetch-http-backend.test.ts` | `fetch` | `real-http` |
| `network/fetch-shallow-http-backend.test.ts` | `fetch.shallow` | `real-http` |
| `network/partial-clone-http-backend.test.ts` | `clone.partial` | `real-http` |
| `network/push-http-backend.test.ts` | `push` | `real-http` |
| `posix-only/node-fs-locked-directory.test.ts` | `nodeFs.lockedDir` | `platform-only` |
| `posix-only/node-fs-mode-bits.test.ts` | `nodeFs.chmod` | `platform-only` |
| `posix-only/node-fs-real-symlinks.test.ts` | `nodeFs.symlinks` | `platform-only` |
| `posix-only/node-hook-runner.test.ts` | `hookRunner` | `real-process` |
| `posix-only/node-hooks-e2e.test.ts` | `hooks.e2e` | `real-process` |
| `win-only/node-fs-windows-real.test.ts` | `nodeFs.windows` | `platform-only` |
| `win-only/openrepository-windows-paths.test.ts` | `openRepository.windowsPaths` | `platform-only` |

`submodules.test.ts` is the canonical `real-fs` resident at root: it drives
the Node-backed `openRepository` against a real tmpdir (not the memory
adapter), but the behaviour under test (`.git/modules/<name>` child-Context
gitdir resolution) is OS-agnostic. Hence bucket `real-fs`, surface
`submodules.walk`, no directory rule (per §5.3). If a Windows-specific
submodule path case lands later, it would split off into `win-only/` under
bucket `platform-only`.

After the sweep, the audit should report zero findings. The same PR enables
`gating.integrationProof: false` (warn-only); a follow-up PR flips it after
one observation cycle.

## 11. Testing strategy

Unit tests under `tooling/test/unit/test-pyramid/`:

- `parse-proves-header.test.ts` — exhaustive grammar coverage (every error
  path in §7 + happy paths).
- `detect-integration-proof.test.ts` — feed synthetic `SourceFile[]` and
  assert `{ missing, duplicate, misplaced }` partitioning. Includes the
  platform-only exemption case (§5.2) and the misplaced-bucket case (§5.3).
- `parse-manifest.test.ts` — extend with `integrationProof` validation
  (missing keys, unknown bucket in `directoryRules`, mismatched `buckets`
  vs `directoryRules` keys).
- `render-report.test.ts` — render the new heuristic section.

Integration tests:

- `tooling/test/integration/audit-test-pyramid.test.ts` (the existing
  audit-runs-end-to-end test) gains a new case: build a temp tree with three
  integration files (one well-formed, one missing-header, one duplicate),
  run the audit, assert the JSON + markdown contain the expected findings.

All new files conform to the existing tooling conventions: GWT titles,
AAA bodies, `sut` variable, branded errors.

## 12. Manifest gating posture

Per [ADR-125](../adr/125-integration-audit-gating-posture.md):

- **Sweep PR** lands the header on all 21 files, the audit heuristic, the
  schema, the sidecar JSON, and `gating.integrationProof: false`.
- **Observation PR** (next phase boundary, no earlier) flips
  `gating.integrationProof: true` once the sweep has stayed clean across
  ≥ 1 merge cycle.

Same posture pattern the project used for ADR-099 (docs PR gate), ADR-104
(pyramid audit), ADR-114 (AAA semantic audit). The pattern works; no need
to invent a new posture for 19.4.

## 13. Risks and trade-offs

- **Adding a new structured artefact in JSDoc is fragile if the parser is too
  strict.** Mitigation: the parser only requires the `@proves` block to exist
  somewhere inside the first JSDoc. The surrounding prose, formatting, and
  whitespace are not constrained. The unit tests pin down every edge case so
  contributors can read the grammar from the test names.
- **Buckets may not map cleanly to a future test that exists for two
  reasons.** E.g. a future test could be both `real-http` and
  `cross-tool-interop`. The current rule (exactly one bucket) forces the
  author to pick the primary justification. If this becomes painful, ADR-122
  can be revised in a follow-up phase; the audit will keep working because
  the bucket enum is data-driven.
- **`submodules.test.ts` is the only `real-fs` resident at root.** Documented
  explicitly in §10 to forestall later "why isn't this multi-adapter-parity?"
  reviews.
- **`real-process` directory rule is conservatively narrow.** Today every
  process-spawning integration test is POSIX-bound (sh hooks, executable
  bits). If a portable subprocess test arrives later (e.g. via a shebang that
  works on every Node target), lift the rule by adding `"root"` to
  `real-process`'s `directoryRules` entry. The data-driven config makes the
  change a one-line manifest tweak, not a code change.
- **The duplicate detector ignores prose overlap.** Two files can have
  identical `unique` strings but different `(surface, bucket)` pairs and be
  silently fine. That's intentional — the human-readable string is for
  reviewers, not for tooling.
- **Single `surface:` per file.** A test that genuinely proves two surfaces
  in one body (e.g. clone-then-fetch in one `it()`) is forced to pick a
  primary. The expected resolution is to split the file by surface; if the
  scenario can't be split, the author picks the surface that motivates the
  test's existence and notes the secondary in the prose. Grammar change to
  accept multiple `surface:` lines would weaken duplicate detection, so it's
  intentionally not supported.

## 14. Out of scope (deferred)

- **Tier-1 / tier-2 surface coverage matrix.** A bigger artefact mapping
  every `repo.*` method to its unit/integration/browser coverage is 19.5a's
  job. 19.4 produces only the integration row of that matrix.
- **Surface aliasing.** If two surfaces refer to the same underlying command
  (e.g. `clone` vs `clone.partial`), the audit treats them as distinct.
  Coalescing is a problem for 19.5a's matrix renderer, not for this audit.
- **Coverage-gap justification audit.** The audit accepts `coverage-gap` as a
  bucket without verifying the gap actually exists. Coverage tooling already
  enforces 100% line/branch/function; if a `coverage-gap` file is mis-bucketed,
  the V8 coverage gate already provides downstream pressure.
