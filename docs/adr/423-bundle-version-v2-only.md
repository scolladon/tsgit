# 423 — bundle emits v2 and refuses v3

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-226 (git-faithfulness)
- **Decision class:** D-SCOPE (user judgment — confirmed as recommended)

## Context

Git bundles come in two formats: v2 (`# v2 git bundle`) and v3 (`# v3 git bundle` with
`@capability` lines). git emits v2 by default and only emits v3 when a capability is
required — `object-format=sha256` or an object `filter`. tsgit is SHA-1 only and has no
partial-clone object filter, so it has no faithful way to *produce* a v3 bundle, and git
would itself emit v2 for the SHA-1 repositories tsgit targets. A v3 bundle would only be
seen on read if one were hand-forced with `--version=3` or carried a filter tsgit cannot
honour. There is no separate v3/sha256 backlog item.

## Options considered

1. **Emit v2; refuse v3 on read** with `BUNDLE_UNSUPPORTED_VERSION` *(designer
   recommendation)* — pros: faithful for the SHA-1 world; YAGNI — git produces v2 for
   equivalent repos; clean, explicit refusal; cons: cannot read a hand-forced v3-sha1
   bundle until a future item adds it.
2. **Emit v2; also read v3-sha1** — pros: wider interop with `--version=3`-forced bundles;
   cons: capability-line parsing surface for a rare input; no consumer demand on the
   roadmap.
3. **Full v3 emit + read** — out of scope: no sha256/filter counterpart exists to make a
   faithful v3 producer.

## Decision

**Option 1 — ratified by the user as recommended**, after confirming v3 is not on the
backlog. tsgit emits v2 bundles and refuses a v3 bundle on read with
`BUNDLE_UNSUPPORTED_VERSION`. v3-read can be added by a future backlog item if a concrete
need appears.

## Consequences

- The header parser recognises the v2 magic line; a v3 magic line is a clean refusal, not
  a parse attempt.
- The version-refusal path is its own discriminated error code (ADR-426), pinned in tests.
