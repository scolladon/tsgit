# ADR-334: A raw-line `scanHeaderPrefix` sibling supplies the same-line end-offset

## Status

Accepted (at `6811dfb9`)

## Context

To scan same-line content after a header, the tokenizer needs the byte offset where the bracket span ends, over the **raw** line. `parseSectionHeader` today takes a *trimmed* line and is shared with the writer's section matcher; it returns identity only, discarding the offset (24.9g's `scanQuotedSpan` already finds the closing `]`/quote, then drops the position).

## Options considered

1. **Add an `endOffset` to `parseSectionHeader`'s `header` arm** — acceptable if documented as raw-line-relative, but muddies the trimmed-input contract shared with the writer matcher.
2. **(recommended) Add a `scanHeaderPrefix(rawLine)` sibling** returning `{ parse, endOffset }`, leaving `parseSectionHeader` untouched — localises the new concern; reuses `scanQuotedSpan`.
3. **Re-derive the offset in the tokenizer** — re-implements the quote-span scan (DRY violation).

## Decision

A new `scanHeaderPrefix(rawLine)` scans the bracket-delimited prefix of a raw line and returns the three-state parse plus the end-offset (just past the closing `]`, or past the closing quote + `]` for a quoted subsection), reusing `scanQuotedSpan`. The tokenizer calls it to find where same-line entry content begins; `parseSectionHeader` keeps its trimmed-input contract for the writer's matchers unchanged.

## Consequences

### Positive

- The raw-line offset concern is localized; matchers keep their trimmed contract; no DRY violation (shared quote-span scan).

### Negative

- Two header entry points (`parseSectionHeader` trimmed identity; `scanHeaderPrefix` raw identity + offset) — kept as deliberately distinct contracts.

### Neutral

- A shared `SectionHeaderParse` shape may back both; `reports/api.json` regenerates if the export surface changes.
