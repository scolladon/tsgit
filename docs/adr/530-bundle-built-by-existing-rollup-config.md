# ADR-530: The bundle is a third config object in the existing `rollup.config.ts`

## Status

Accepted (at `9e128c04`) — adopted-as-recommended (no user judgment)

## Context

The single-file output needs a producer. It cannot be a third `output` on the
existing multi-entry config (a `file:` output and `inlineDynamicImports` are both
incompatible with multi-entry input — a rollup structural fact). Alternatives: a
third config object in the existing array, a separate `rollup.browser.config.ts`
with its own wireit script, or a script outside `build` wired only into checks.

## Decision

A third config object appended to the array `rollup.config.ts` already exports,
produced by the same `rollup -c` that `build:js` runs. `wireit.build:js.output`
gains `dist/browser/**` so the artefact is cached and cleaned correctly. The
`visualizer` plugin is not repeated (it would clobber
`reports/bundle-analysis.html`).

## Consequences

### Positive

- One toolchain, one invocation; `npm run build` always yields a complete
  `dist/` for every downstream consumer (e2e, runtime-parity, `npm pack`, the CI
  `dist` artifact).
- No duplicated plugin setup to drift.

### Negative

- +4.2 s on the measured 25.5 s build, paid on every build.

### Neutral

- CI needs no new job; the `build` job already runs build + size + exports
  checks and uploads `dist/`.
