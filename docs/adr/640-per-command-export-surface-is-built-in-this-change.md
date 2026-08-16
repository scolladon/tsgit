# 640 — The per-command export surface is built, in this change

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidates D1, D5)

## Context

`package.json` exports `"./commands/*"` and the commands design promises per-command
imports at ~1.5 kB gzipped each, but `rollup.config.ts` builds exactly one entry under
that prefix (`commands/index`). Pinned on 3.3.0: `@scolladon/tsgit/commands/add` fails
with `ERR_MODULE_NOT_FOUND`; the built barrel is reachable only through the undocumented
`./commands/index`. The advertised surface does not exist, and the browser no-build
bundle sits at 156.04 / 160 kB gzip with no structural cap other than per-command
splitting.

## Options considered

1. **Retract the wildcard until built (design recommendation)** — pros: small, honest
   edit; L-effort split chosen deliberately later / cons: semver-relevant removal of the
   one working specifier; the promised surface stays unshipped.
2. **Build ~49 real per-command entries — own follow-up run** — pros: keeps this
   remediation PR reviewable / cons: ships the broken surface one release longer.
3. **Build ~49 real per-command entries — in this change** — pros: the package becomes
   honest and the browser-bundle ceiling gains a structural answer now / cons: L-effort
   item riding a remediation PR; ~49 rollup entries, `.size-limit.json` rows and attw
   pairs land in the same diff.

## Decision

**Option 3 (user-ratified — deviates from the design recommendation).** The per-command
entries are built in this change: one rollup entry per command under `commands/`, with
matching `.size-limit.json` budget rows and `check:exports` (attw) coverage.
`tooling/dts-entries.ts` already expands wildcard subpaths against `dist/`, so the
truthful-`.d.ts` audit picks the split up without modification. The candidate-D5 question
(own run vs this PR) is settled by this same ratification: it rides this PR.
