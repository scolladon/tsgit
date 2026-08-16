# 638 — CI tracks Node release lines by alias, not pinned majors

- **Status:** accepted
- **Date:** 2026-08-15
- **Design:** docs/design/depth-caps-and-node-aliases.md · **Supersedes/Refines:** refines ADR-103 (CI code-change gating); interacts with ADR-483 (benchmark provenance)

## Context

Every Node version in `.github/` was a hardcoded major. `dependabot.yml` groups the `github-actions` ecosystem, so the **action major** stayed current while the **`node-version` value** drifted until a human noticed. Four sites carried a pin, and one of them dominates: `.github/actions/setup/action.yml`'s `inputs.node-version.default: "22"` is inherited by **27 of 28 composite call sites** — only `unit-tests` passes a version, from a `node: [22, 24]` matrix. Two jobs bypass the composite with a bare `actions/setup-node@v7`.

Read off `actions/setup-node@v7`'s own source rather than from memory: an alias resolves to a bare **major** string (`release.version.split('.')[0]`) which is then resolved as an ordinary semver spec, against `actions/node-versions`' manifest filtered to `lts && stable`. An unresolvable alias throws; it does not fall back. So `lts/-1` → `22` and `lts/*` → `24` today — **byte-equivalent to the existing matrix**, and self-rolling at the next LTS promotion. `latest` is different in kind: it resolves from the dist endpoint rather than the pre-cached manifest, so it frequently misses the runner tool cache.

Two consequences of the switch were not visible from the pin list, both inside `unit-tests` and both **silent**:

- `if: always() && matrix.os == 'ubuntu-latest' && matrix.node == 22` is not a version pin but a **comparison literal**. Under alias values it is permanently false, so the coverage artifact is never uploaded. Nothing fails.
- `name: coverage-report-${{ matrix.os }}-node${{ matrix.node }}` would render an alias containing `/` or `*`, both in `upload-artifact`'s rejected-character set. The step would hard-error — except the first breakage guarantees it never runs, masking it.

Branch protection was re-verified live: the legacy protection API returns 404, and ruleset `16502004` requires exactly one check, `build`, which has no matrix and therefore a stable check name. Matrix cell renames cannot break protection — and the same fact means the whole unit-test matrix is **advisory**, which raises the cost of the coverage breakage from "CI turns red" to "coverage evidence quietly stops being produced".

`package.json` declares `engines.node: ">=22.22.1"` and the root `.npmrc` sets `engine-strict=true`, so the floor is a live mechanical gate on `npm ci` in all 27 inheriting jobs, not documentation.

## Options considered

1. **Composite default `lts/*`, matrix `['lts/-1', 'lts/*', 'latest']`** — pros: non-matrix jobs get faster feedback on the line most consumers run; the floor is still covered by a matrix cell / cons: every non-matrix job tests the newest supported line while the package promises the oldest.
2. **Composite default `lts/-1` (recommended)** — pros: the 27 non-matrix jobs assert "this works" on the oldest line the project claims to support, the configuration most likely to break and least likely to be exercised elsewhere / cons: slower feedback on the line most consumers use.
3. **Drop `latest`, keep six cells** — pros: no CI cost increase, no unpinned cell / cons: forgoes the Current-line early warning entirely.

## Decision

**Option 1 (user-ratified), with `latest` blocking.** No hardcoded Node major remains anywhere in `.github/`.

- `.github/actions/setup/action.yml` defaults to **`lts/*`**. All 27 inheriting jobs move from 22 to 24 on merge and roll forward on their own thereafter.
- `unit-tests` runs **`node: ['lts/-1', 'lts/*', 'latest']`** across three OSes — nine cells, all **blocking**. `latest` is not `continue-on-error`: a Node major that breaks this project is treated as a real signal, and the design's own counter-argument (an unpinned cell can turn CI red on an empty diff) is accepted as the price of the warning.
- `benchmark-compare` keeps its deliberate composite bypass — the composite runs `npm ci` with no `working-directory:` and this job has no root `package.json`, only `base/` and `head/`, and needs `cache-dependency-path` over both lockfiles. Only the version value is aliased.
- `npm-service.yml` takes `lts/*` rather than staying pinned at 24. Its pin existed to guarantee **npm ≥ 11** for the trusted-publisher OIDC PUT path, not to express a Node preference; `lts/*` satisfies that floor today and, because npm majors are monotonic across LTS lines, by construction thereafter. Its comment is rewritten from "we pin 24 to get npm 11" to "the npm ≥ 11 floor is why this can never go below the current LTS".
- The coverage cell is re-anchored so it is coupled to **no** version literal: one matrix cell carries a `coverage: true` flag via `include:`, the condition gates on that flag, and the artifact is named `coverage-report-${{ matrix.os }}`. Re-coupling to a different literal would rearm the same trap at the next matrix change.
- `engines.node` does **not** move with the lines. It is a *consumer* contract (what a user of the published package must run); the matrix is a *CI* contract (what the project tests on). Raising it is semver-relevant and stays a separate, deliberate act.

## Consequences

The floor never falls, so `engine-strict` can only fire if someone writes `lts/-2` — which resolves to 20 today and would fail `npm ci` loudly across 27 jobs. That is the correct failure mode: immediate, not a silent test run on an unsupported runtime.

One gap is accepted knowingly. Once `lts/-1` advances past 22, **nothing in CI runs on the declared `engines.node` minimum** while the package still claims to support it. The matrix's floor cell tracks the oldest LTS, which is the closest available proxy, not the declared floor itself.

The matrix comment explaining why Node 20 was dropped is rewritten rather than deleted: under aliases it documented a floor no longer visible in the matrix, so the replacement relocates the authority to `engines.node` plus `.npmrc`'s `engine-strict=true` and names the mechanism that enforces it, while keeping the historical fact that `cspell@10` and `lint-staged@17` are what set the floor.

`unit-tests` goes from six cells to nine with `fail-fast: false`, a 50% increase in the repo's most-run job. `latest` additionally resolves from the dist endpoint rather than the pre-cached manifest, so it carries download and rate-limit exposure the LTS aliases avoid.

**The benchmark series shifts on merge, not at some future LTS promotion.** `bench.yml` and `benchmark-snapshot` both reach Node through the composite action, so `lts/*` moves the nightly from 22 to 24 immediately, and every number in the `gh-pages` series steps underneath a continuous graph with no code change to attribute it to. Under ADR-483 those are the citable numbers. The resolved Node version therefore belongs in the snapshot metadata, so a step change reads as a runtime change rather than a regression.

Cache keys do **not** rotate. `setup-node@v7`'s key is `node-cache-${platform}-${arch}-${packageManager}-${hash(lockfile)}` — the Node version has never been part of it, so today's 22 and 24 cells already share one entry per OS+arch and aliasing changes nothing. A cold cache after a Node release is therefore *not* an expected effect of this change.

One day-one risk is accepted rather than pre-cleared: 16 npm scripts and two workflow steps pass `--experimental-strip-types`, and whether the Current line still accepts it was not verified. With `latest` blocking, this PR's own CI run is the test — `.github/` counts as code under ADR-103, so the full nine-cell matrix runs on the change that introduces it. If the `latest` cell is red on day one, that flag is the first thing to look at, and the decision to keep the cell blocking is the thing to revisit.
