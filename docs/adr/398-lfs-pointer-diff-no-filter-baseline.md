# ADR-398: LFS pointer diff — the no-filter-port faithfulness baseline

## Status

Accepted

- **Date:** 2026-06-21
- **Design:** [design/diff-faithfulness-odds-ends.md](../design/diff-faithfulness-odds-ends.md) §1
- **Refines:** [ADR-226](226-git-faithfulness-prime-directive.md) (git-faithfulness), [ADR-249](249-describe-structured-data-only.md) (structured output)

## Context

A downstream consumer reported git-lfs pointer handling as "wired but untested".
tsgit has **no filter / clean-smudge / textconv port**, so it stores and diffs a
git-lfs pointer file (`version https://git-lfs.github.com/spec/v1` / `oid sha256:…`
/ `size …`) exactly as its on-disk text bytes. git's diff over an lfs-tracked path
diverges only when a `filter=lfs diff=lfs` attribute is **active** with an installed
driver — then git substitutes the smudged content. With no active driver, git diffs
the pointer text, which is precisely what tsgit produces.

The question is which behaviour tsgit pins as its faithful target, and how thorough
the pin is.

## Options considered

- **Faithfulness baseline:** (a) git with **no active lfs filter** — the pointer
  blob is the committed content, diffed as text; (b) git with an active git-lfs
  driver (smudged diff). **Chose (a)** — (b) is unreachable without inventing a
  filter port; tsgit can only ever produce (a), and (a) is faithful to git run in
  the same no-driver environment.
- **Pin thoroughness:** (a) full matrix — pointer add + pointer modify +
  pointer→real-file, PLUS a `.gitattributes diff=lfs`-declared-but-no-driver
  non-interference case; (b) add + modify only; (c) a single round-trip add.
  **Chose (a)** — the realistic consumer/CI case is "an lfs attribute is declared
  but no driver runs"; (a) pins exactly that boundary, where a future filter port
  would otherwise regress silently.

## Decision

The faithful target for LFS pointer diffs is **git with no active `filter=lfs` /
`diff=lfs` driver**. tsgit reproduces it byte-for-byte by diffing the pointer blob
as ordinary text — **no tsgit source change**; the deliverable is fixtures + a
cross-tool interop test.

The interop pin (`test/integration/lfs-pointer-interop.test.ts`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, scrubbed `GIT_*`, signing off) covers the **full matrix**:

- **pointer add** — an `add` whose blob is the three-line pointer text;
- **pointer modify** — `oid`/`size` bump is a text `modify`;
- **pointer → real file** — the path stops being lfs-tracked and becomes its real
  bytes: a text `modify` whose new side is the real content;
- **declared-but-inert driver** — a committed `.gitattributes` naming `diff=lfs`
  with **no** driver installed in the isolated environment: git falls back to the
  built-in text diff and tsgit matches.

Each row reconstructs git's `--name-status` / `--numstat` / patch bytes from the
structured `TreeDiff` and compares to live `git`.

An LFS filter / clean-smudge / textconv port (the active-driver case) is **out of
scope** — a separate, large item. This ADR declares the boundary so the interop
environment hardening (no driver in `HOME`) is understood as deliberate.

## Consequences

### Positive

- The consumer's "wired but untested" concern becomes a frozen, tested contract.
- The declared-but-inert-driver pin guards the realistic CI case and marks the exact
  regression boundary a future filter port must not silently cross.

### Negative

- LFS pointers tracked with a real, installed git-lfs driver are not (and cannot be)
  reproduced until a filter port exists — accepted, and explicitly documented.

### Neutral

- No tsgit code path is added; the contract is "tsgit ≡ filter-less git over pointer
  text", which only the interop harness can prove (parity tests are cross-adapter and
  do not prove faithfulness).
