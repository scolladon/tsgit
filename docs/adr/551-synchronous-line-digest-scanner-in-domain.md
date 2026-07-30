# 551 — One synchronous chunk-fed line-digest scanner, in the domain layer

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none · **Refined by:** ADR-558

> **Refined by ADR-558.** The "bodies move verbatim" clause below does **not** hold for
> the digest folders or `takeLine`: ADR-558 replaces per-line buffering with an
> incremental O(1) fold. The decision this ADR actually records — one synchronous
> chunk-fed scanner, in `src/domain/diff/`, driving both arms — stands unchanged.

## Context

ADR-550 leaves the predicate with two arms. The semantics they must share — buffering,
LF scanning with a resume cursor, the NUL detection window, the line-length and
line-count caps, digesting, blank-line skipping — are today an async state machine living
in the application layer, coupled to where its bytes come from.

## Options considered

1. **A new pure `src/domain/diff/line-digest-scanner.ts`** with a synchronous
   `push`/`end`/`next` API (designer's recommendation) — pros: the two arms drive the
   *same* code, so semantic identity holds by construction rather than by test; puts a
   platform-free state machine next to `line-diff.ts`, whose caps it mirrors, and
   `whitespace.ts`, whose digests it consumes; unlocks synchronous chunk-boundary tests /
   cons: largest diff of the three.
2. **Keep it in the predicate and write a second buffered code path beside the streaming
   one** — cons: duplicates exactly the semantics that must never drift.
3. **Keep the async-iterator core; the buffered arm is a single-chunk `AsyncIterable`** —
   the honest minimal-diff alternative, not a straw man: fed from the same seam it still
   removes the WHATWG streams and `createInflate`, and still keeps one state machine.
   Cons: retains the per-line `Promise.all`, the async-generator frames and
   `runMicrotasks`. Most of the win for a much smaller blast radius.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. `createLineDigestScanner(key,
ignoreBlankLines)` returns `{ push, end, next, binary }`, where `next()` yields
`{ kind: 'digest' | 'needs-input' | 'exhausted' }` and never throws. The bodies of
`concatBytes`, `scanForNul`, `trackLineCaps`, `takeLine`, `nextLine` and
`nextSignificantDigest` move verbatim apart from `await`/`Promise` removal and the
`needs-input` return replacing `await iterator.next()`.

## Consequences

Chunk-count invariance is the property that makes one scanner safe for both arms, and it
holds for the two places chunking could have leaked: `scanForNul` accumulates
`nulScanOffset` across pushes so N chunks and one whole-blob chunk both scan exactly the
first `BINARY_DETECTION_BYTES`; and the pending-bytes cap is only *reached* when the
buffer holds no LF, so `buffer.length` is always the pending unterminated byte count
regardless of how many pushes filled it — a whole-blob push cannot make a
many-short-lines file trip `MAX_LINE_BYTES`. That second property is the one ADR-552
requires re-proved by hand and pinned as an executable test. The dependency rule is
respected and improved: this change *removes* a domain-shaped state machine from the
application layer. No new port, no adapter method, no public export, no
`reports/api.json` churn.
