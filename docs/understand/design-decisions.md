# Design decisions

A curated index of [Architecture Decision Records](../adr/). Each entry is a one-line decision summary; click through for the context, trade-offs, and alternatives considered.

ADRs are ordered chronologically in the `adr/` folder. This page groups them by subsystem so a reader asking "why was X chosen?" can find the answer fast.

## Foundations

- [ADR-001 — Hexagonal architecture](../adr/001-hexagonal-architecture.md) — ports & adapters, dependency rule, layer split
- [ADR-002 — Rollup for the build](../adr/002-rollup-for-build.md) — dual ESM/CJS, tree-shakeable
- [ADR-003 — Error extension strategy](../adr/003-error-extension-strategy.md) — `TsgitError` discriminated union
- [ADR-004 — Adapter errors in the domain](../adr/004-adapter-error-in-domain.md) — `FILE_NOT_FOUND` lives in the domain so commands can switch on it without knowing the adapter

## Clone, fetch, push (network)

- [ADR-005 — Smart-HTTP v1 only for clone](../adr/005-clone-protocol-v1.md) — smart-HTTP v2 deferred
- [ADR-006 — Clone pack storage layout](../adr/006-clone-pack-storage-layout.md)
- [ADR-007 — Clone resume semantics](../adr/007-clone-resume-semantics.md) — in-memory pack buffer, streaming deferred
- [ADR-008 — Defer shallow clone to Phase 12.2](../adr/008-clone-defer-shallow.md)
- [ADR-009 — Where shallow lives in fetch](../adr/009-fetch-shallow-where.md)
- [ADR-010 — Fetch `have` strategy](../adr/010-fetch-haves-strategy.md)
- [ADR-011 — Fetch ref-update transaction](../adr/011-fetch-ref-update-tx.md)
- [ADR-012 — Fetch prune semantics](../adr/012-fetch-prune-semantics.md)
- [ADR-013 — Push pack encoding](../adr/013-push-pack-encoding.md)
- [ADR-014 — Push refspec scope](../adr/014-push-refspec-scope.md)
- [ADR-015 — Push force-with-lease](../adr/015-push-force-with-lease.md) — `'auto'` lease vs explicit oid
- [ADR-016 — Push atomic transaction](../adr/016-push-atomic-tx.md)

## Working-tree fidelity (checkout / reset / merge)

- [ADR-018 — Checkout atomicity model](../adr/018-checkout-atomicity-model.md) — per-file atomic, matches canonical git
- [ADR-019 — Checkout dirty-tree guard](../adr/019-checkout-dirty-tree-guard.md)
- [ADR-020 — Checkout `{ paths }` API shape](../adr/020-checkout-paths-api-shape.md)
- [ADR-021 — `reset --mixed` stat-cache donor strategy](../adr/021-reset-mixed-stat-cache-donor.md)
- [ADR-022 — `reset --mixed` pathspec scope (deferred)](../adr/022-reset-mixed-pathspec-scope.md)
- [ADR-023 — `reset --hard` index stat source](../adr/023-reset-hard-index-stat-source.md)
- [ADR-024 — Where the bounded-read cap fires](../adr/024-bounded-reads-where-cap-fires.md)
- [ADR-025 — Parallel blob reads for merge](../adr/025-merge-parallel-blob-reads.md)
- [ADR-026 — Merge conflicts return, do not throw](../adr/026-merge-conflict-returns-not-throws.md)
- [ADR-027 — Merge conflict write order](../adr/027-merge-conflict-write-order.md)
- [ADR-028 — Merge message content](../adr/028-merge-msg-content.md)

## Pathspec, ignore, Windows

- [ADR-029 — `add --all` ignore stub](../adr/029-add-all-ignore-stub.md)
- [ADR-030 — `add --all` walk strategy](../adr/030-add-all-walk-strategy.md)
- [ADR-031 — `add --all` symlink/gitlink policy](../adr/031-add-all-symlink-gitlink-policy.md)
- [ADR-032 — `add --all` large-file guard](../adr/032-add-all-large-file-guard.md)
- [ADR-033 — `.gitignore` sources & ordering](../adr/033-gitignore-sources.md)
- [ADR-034 — `homeDir` injection for ignore evaluation](../adr/034-homedir-injection.md)
- [ADR-035 — Walk-time ignore pruning](../adr/035-walk-ignore-pruning.md)
- [ADR-036 — `.gitignore` bounded read](../adr/036-gitignore-bounded-read.md)
- [ADR-037 — Pathspec auto-detect (glob vs literal)](../adr/037-pathspec-auto-detect.md)
- [ADR-038 — Pathspec `!` exclusion](../adr/038-pathspec-exclusion.md)
- [ADR-039 — Status pathspec deferred](../adr/039-defer-status-pathspec.md)
- [ADR-040 — Extracted `compileGlob`](../adr/040-extracted-compile-glob.md)
- [ADR-041 — Windows testing strategy](../adr/041-windows-testing-strategy.md)
- [ADR-042 — Canonical root lazy realpath](../adr/042-canonical-root-lazy-realpath.md)
- [ADR-043 — Errno mapping placement](../adr/043-errno-mapping-placement.md)
- [ADR-044 — CI matrix inclusion of `windows-latest`](../adr/044-ci-matrix-windows-inclusion.md)
- [ADR-045 — Separator normalisation policy](../adr/045-separator-normalisation-policy.md)
- [ADR-046 — `PathPolicy` abstraction](../adr/046-path-policy-abstraction.md)
- [ADR-047 — FS operations dependency injection](../adr/047-fs-operations-dependency-injection.md)
- [ADR-048 — Platform-segregated test folders](../adr/048-platform-segregated-test-folders.md)
- [ADR-077 — Linear (non-backtracking) glob matcher](../adr/077-linear-glob-matcher.md)

## Bench & observability

- [ADR-017 — Bench CGI server lifecycle](../adr/017-bench-cgi-server-lifecycle.md)
- [ADR-054 — Bench fixture generation caching](../adr/054-bench-fixture-generation-caching.md)
- [ADR-055 — Per-OS mutation nightly](../adr/055-per-os-mutation-nightly.md)
- [ADR-056 — Benchmark snapshot converter schema](../adr/056-benchmark-snapshot-converter-schema.md)

## Supply chain

- [ADR-057 — SHA-pinning GitHub Actions abandoned](../adr/057-action-sha-pinning.md)

## Reflog (Phase 17.1)

- [ADR-058 — Reflog integration point (auto-logging via `recordRefUpdate`)](../adr/058-reflog-integration-point.md)
- [ADR-059 — HEAD dual logging](../adr/059-head-dual-logging.md)
- [ADR-060 — `appendUtf8` port method](../adr/060-append-utf8-port.md)
- [ADR-061 — Reflog identity resolution](../adr/061-reflog-identity.md)
- [ADR-062 — Approxidate parser subset](../adr/062-approxidate-subset.md)
- [ADR-063 — `core.logAllRefUpdates` gate logic](../adr/063-log-all-ref-updates.md)
- [ADR-064 — Reflog command shape](../adr/064-reflog-command-shape.md)

## Hooks (Phase 17.2)

- [ADR-065 — `HookRunner` port](../adr/065-hook-runner-port.md)
- [ADR-066 — Hooks default-on (Node)](../adr/066-hooks-default-on.md)
- [ADR-067 — `COMMIT_EDITMSG` round-trip for `commit-msg`](../adr/067-commit-msg-editmsg-roundtrip.md)
- [ADR-068 — Windows hook execution](../adr/068-windows-hook-execution.md)

## Sparse checkout (Phase 17.3)

- [ADR-069 — Skip-worktree index v3](../adr/069-skip-worktree-index-v3.md)
- [ADR-070 — Cone + non-cone modes](../adr/070-cone-and-non-cone.md)
- [ADR-071 — Sparse command shape](../adr/071-sparse-command-shape.md)
- [ADR-072 — Sparse dirty-file policy](../adr/072-sparse-dirty-file-policy.md)
- [ADR-073 — Sparse integration scope](../adr/073-sparse-integration-scope.md)
- [ADR-074 — Minimal config writer for `[core]`](../adr/074-minimal-config-writer.md)
- [ADR-075 — Reset sparse integration](../adr/075-reset-sparse-integration.md)
- [ADR-076 — Merge conflict materialization respects sparse](../adr/076-merge-conflict-materialization.md)

## Partial clone (Phase 17.4)

- [ADR-078 — Partial-clone filter scope](../adr/078-partial-clone-filter-scope.md)
- [ADR-079 — Automatic + batch lazy-fetch](../adr/079-lazy-fetch-automatic-plus-batch.md)
- [ADR-080 — Lazy-fetch sends no filter](../adr/080-lazy-fetch-sends-no-filter.md)
- [ADR-081 — `PromisorRemote` port](../adr/081-promisor-remote-port.md)
- [ADR-082 — Generalised `[section]` config writer](../adr/082-generalised-config-section-writer.md)

## Submodules (Phase 17.5)

- [ADR-083 — Submodule API surface (command + primitive pair)](../adr/083-submodule-api-surface.md)
- [ADR-084 — Tree-ish as the submodule data source](../adr/084-submodule-data-source.md)
- [ADR-085 — Nested submodule recursion via child Context](../adr/085-nested-submodule-recursion.md)
- [ADR-086 — INI tokenizer reuse for `.gitmodules`](../adr/086-gitmodules-ini-reuse.md)

## `cat-file --batch` (Phase 17.6)

- [ADR-087 — Cat-file API shape (dual primitive + command)](../adr/087-cat-file-api-shape.md)
- [ADR-088 — Per-entry missing sentinel](../adr/088-cat-file-missing-per-entry.md)
- [ADR-089 — Contents-only mode](../adr/089-cat-file-contents-only.md)
- [ADR-090 — Strict order, sequential reads](../adr/090-cat-file-strict-order-sequential.md)

## Documentation structure (Phase 18.2)

- [ADR-091 — Abandon isomorphic-git compatibility shim](../adr/091-abandon-isomorphic-git-shim.md)
- [ADR-092 — Audience-first documentation structure](../adr/092-audience-first-doc-structure.md)
- [ADR-093 — Drop `DESIGN.md` and `MIGRATION.md` without redirect stubs](../adr/093-drop-design-and-migration-md.md)
- [ADR-094 — README honesty boundaries](../adr/094-readme-honesty-boundaries.md)

## Doc-maintenance harness (Phase 18.3)

- [ADRs 095–099 — Link checker, API coverage source of truth, regex parser, TypeDoc drift, docs PR gate](../adr/095-doc-link-checker-tool.md)

## Mutation pyramid (Phase 19.1)

- [ADR-100 — Bucket partition: domain / application / adapters / infra](../adr/100-mutation-pyramid-bucket-partitioning.md)
- [ADR-101 — Per-bucket mutation thresholds (high / low / break)](../adr/101-mutation-budgets-per-bucket.md)
- [ADR-102 — Remove the per-OS nightly mutation job (supersedes ADR-055)](../adr/102-remove-per-os-mutation-nightly.md)
- [ADR-103 — Skip code-dependent CI jobs when the diff has no code changes](../adr/103-ci-code-change-gating.md)
- Design: [`docs/design/phase-19-1-mutation-pyramid.md`](../design/phase-19-1-mutation-pyramid.md)

## Testing-pyramid audit + expressiveness lint (Phases 19.2 / 19.3 / 19.3a / 19.3c)

- [ADRs 104–108 — Directory-based classification, ratio targets, heuristics, tooling/mutation policy](../adr/104-pyramid-audit-report-only.md)
- [ADRs 109–113 — Gating posture, sut-naming denylist, bare-class toThrow ban, AAA marker grammar, GWT title regex](../adr/109-pyramid-audit-gating-posture.md)
- [ADRs 114–116 — AAA semantic audit hybrid posture, empty AAA section grammar, sweep policy](../adr/114-aaa-semantic-audit-hybrid-posture.md)
- [ADR-117 — GWT clause partitioning between `describe` and `it`](../adr/117-gwt-clause-partitioning-describe-it.md)
- [ADR-118 — Two-pass scanner with offset-containment join](../adr/118-two-pass-scanner-describe-it-join.md)
- Design: [`docs/design/phase-19-3c-gwt-describe-it-split.md`](../design/phase-19-3c-gwt-describe-it-split.md)

## CI hygiene

- [ADR-119 — Cancel-on-merge workflow scope](../adr/119-cancel-on-merge-workflow.md)

## Integration-test usefulness audit + E2E parity harness (Phases 19.4 / 19.5)

- [ADR-120 — Two-stage `it.skipIf` / `it.runIf` scanner support](../adr/120-skipif-runif-non-skipped-at-scan.md)
- [ADRs 121–126 — `@proves` grammar, integration bucket taxonomy, duplicate detection, usefulness heuristic, gating posture, sweep policy](../adr/121-integration-proves-header-grammar.md)
- [ADR-127 — Browser parity scenarios are bundled, not function-source-serialized](../adr/127-parity-scenarios-bundled-not-serialized.md)
- [ADR-128 — Golden `commit.id` per scenario as the load-bearing determinism signal](../adr/128-golden-commit-id-as-parity-signal.md)
- [ADR-129 — Parity scenarios are additive in 19.5; duplicate browser specs retired in 19.5a](../adr/129-parity-scenarios-additive-no-deletion-in-19-5.md)
- Design: [`docs/design/phase-19-5-e2e-harness-upgrade.md`](../design/phase-19-5-e2e-harness-upgrade.md)

## Reading order tips

- **Onboarding to the codebase?** Read ADR-001, ADR-004, ADR-091 in order. They set the architectural ground rules.
- **Touching the working-tree path?** Read ADR-018 through ADR-028 — the merge / checkout / reset family is the most subtle subsystem.
- **Touching pathspec / ignore?** Read ADR-037, ADR-038, ADR-039, ADR-077 first.
- **Writing tests?** Read ADR-041, ADR-047, ADR-048 — the testing-strategy choices that the rest of the suite follows.
