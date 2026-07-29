# ADR-526: CDN exposure via top-level `unpkg`/`jsdelivr` fields, no exports subpath

## Status

Accepted (at `9e128c04`) — user-ratified

## Context

CDN consumers address a package either by its bare root URL
(`https://unpkg.com/@scolladon/tsgit`) or by a literal tarball path. Live probes
pinned that both unpkg and jsDelivr ignore the `exports` map entirely: an
exports-only subpath 404s on both CDNs, and the bare root URL today falls back to
`main` — the CommonJS entry, which throws `require is not defined` in a browser.
A `"./browser"` exports subpath would serve bundler users only (already served by
`/auto/browser`), and the only attw-green subpath shape resolves `import` and
`require` to two different artefacts under one name.

## Decision

Expose the bundle through two top-level `package.json` fields only —
`"unpkg": "dist/browser/tsgit.js"` and `"jsdelivr": "dist/browser/tsgit.js"`
(no `./` prefix; the in-the-wild proven form). No new `exports` subpath. No
top-level `"browser"` field (it would change legacy-bundler resolution for the
whole package).

## Consequences

### Positive

- The bare CDN root URL serves working browser ESM instead of throwing CJS.
- The deep literal path works on every CDN with or without the fields.
- `exports` map untouched; bundler resolution and `check:exports` (attw) pinned
  neutral.

### Negative

- No `@scolladon/tsgit/browser` bundler specifier for the bundle — deliberate;
  bundler users get a better result from the code-split entries.

### Neutral

- CDN-root resolution is verifiable only post-release (fields read from the
  published tarball); listed as a post-release manual check.
