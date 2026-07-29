# ADR-525: Single-file browser bundle lives at `dist/browser/tsgit.js`

## Status

Accepted (at `9e128c04`) — adopted-as-recommended (no user judgment)

## Context

The no-build browser distribution adds one single-file, minified ESM bundle of the
browser entry. It needs a home in `dist/`. Candidates: `dist/browser/tsgit.js`,
`dist/esm/tsgit.browser.js`, or `dist/tsgit.browser.js`. The `check:size`
`Full library` budget globs `dist/esm/**/*.js` (335 kB gzip); placing the bundle
inside `dist/esm/` was measured to consume that budget from 50.8 % headroom down
to 10.2 % while measuring a duplicate of code already counted.

## Decision

The bundle is emitted at `dist/browser/tsgit.js` — its own format directory
beside `dist/esm/`, `dist/cjs/`, and `dist/types/`.

## Consequences

### Positive

- The `Full library` size budget keeps measuring the code-split library only
  (unchanged 164 674 B / 335 000 B).
- The CDN path is self-describing: `…/dist/browser/tsgit.js`.
- Consistent with the existing one-directory-per-format `dist/` layout.

### Negative

- One more top-level directory in `dist/` for a single file.

### Neutral

- The tarball grows by the artefact's size wherever it sits (see ADR-528).
