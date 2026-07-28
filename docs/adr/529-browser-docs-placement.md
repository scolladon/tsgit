# ADR-529: Browser consumption paths documented in README + `docs/get-started/browser.md`

## Status

Accepted (at `9e128c04`) — adopted-as-recommended (no user judgment)

## Context

The package now has two browser consumption paths: bundler (exports map, as
today) and CDN/no-build (the single-file bundle). `docs/get-started/browser.md`
documents only the bundler path; the README runtime table has one browser row.
Alternatives: README-only, or a new dedicated `browser-cdn.md` page.

## Decision

Both paths live side by side: the README runtime table gains a
*Browser (no build)* row, and `docs/get-started/browser.md` gains a
*No build step (CDN)* section with a copy-runnable page. CDN URLs live inside
code fences (lychee does not extract fenced/inline-code URLs; a prose link to the
not-yet-published path would turn `check:doc-links` red pre-release). The primary
snippet pins the floating major (`@3`), with the exact-pin form documented for
production.

## Consequences

### Positive

- One landing page serves the whole browser audience; the reader picks a path.
- No new cross-link surface for `check:doc-links` to police.

### Negative

- `browser.md` grows; two audiences share one page.

### Neutral

- README-only would leave the canonical browser page wrong-by-omission; a
  dedicated page would split one audience across two.
