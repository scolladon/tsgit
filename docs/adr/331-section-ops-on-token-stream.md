# ADR-331: `rename`/`remove-section` move to the token stream (same-line aware, no key validation)

## Status

Accepted (at `6811dfb9`)

## Context

The pinned git 2.54 matrix shows `git config --rename-section`/`--remove-section` are **event-driven**: they split a same-line header from the entry being re-emitted (`[a] key=v` rename → `[b]⏎⇥key = v`), copy the entry tail **raw**, and stay **lenient** on bad keys / malformed values (git's `copy_or_rename` finds byte offsets via parser events but does not run the key validator). tsgit's `renameConfigSectionInText`/`removeConfigSectionInText` are still line-based (24.9i kept them so, pinning only inputs line surgery could express) and **no-op** on `[a] key = v`.

## Options considered

1. **(recommended) Move both to the token stream** — recognise same-line headers via the new tokenizer, split on rewrite, copy the raw tail, match via `rawSectionName` (24.9k), with **no** `scanKey` key/value validation (stays lenient like git). Pros: closes the byte divergence; subsumes verbatim non-matching-block copy. Cons: larger-than-24.9i rewrite.
2. **Keep line-based**, document the same-line no-op as a backlog follow-up — cons: leaves a byte-faithfulness gap ADR-226 forbids.
3. **Hybrid** (token-find matches, raw line-copy non-matches) — subsumed by (1), which already copies non-matching blocks byte-for-byte.

## Decision

`renameConfigSectionInText` and `removeConfigSectionInText` operate on the `ConfigToken` stream. Header matching uses `rawSectionName`. **Rename** re-emits `renderSectionHeader(to)` then, for a same-line header, `⏎⇥` + the raw remaining bytes of the original line from the entry start, then the body verbatim. **Remove** drops the matching header and its whole body span. Neither runs `scanKey`'s validation — they stay lenient on bad keys and malformed values exactly as git's `copy_or_rename` (consistent with ADR-313's read-shape-vs-line-surgical split). This **supersedes** 24.9i's "keep line-based here" rationale.

## Consequences

### Positive

- Byte-identical rename/remove on same-line and orphan-prefixed files.
- Leniency matches git, so the write-side blast radius does not grow.

### Negative

- The section-op primitives gain token-stream complexity; more interop rows to pin.

### Neutral

- tsgit still never produces same-line files; this only affects surgery on hand-authored ones.
