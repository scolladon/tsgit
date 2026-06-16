# ADR-346: Remaining valueless-refusal scope — faithful-maximal

## Status

Accepted

## Context

24.9l (ADRs 327–329) shipped the `CONFIG_MISSING_VALUE` refusal for the two families that were *mechanical* — git dies on a valueless string read **and** tsgit already had a refusal-path consumer (identity; remote-URL). ADR-329 deferred the remaining string-typed families as dependency-ordered follow-ups. This is 24.9r, that follow-up.

The empirical pinning (design `remaining-valueless-refusal.md`, git 2.54.0) split the five brief families three ways:

1. git dies **and** tsgit already refuses (`branch.*.merge`/`remote` at `pull`; `remote.*.pushUrl` at `fetch`/`push`) — pure mechanical extension.
2. git dies but tsgit's consumer collapses the valueless case to a **benign fallback** with no refusal (`merge.*.driver`/`name` → built-in `text`; `core` path-likes → silent miss). Adding faithfulness here means *introducing a refusal tsgit lacks today*.
3. git does **not** die (`submodule.*.url`/`update`) — nothing to be faithful to.

The design recommended faithful-minimal (only category 1; defer category 2). The user chose the opposite: maximise faithfulness.

## Decision

**Faithful-maximal scope.** This PR adds a `CONFIG_MISSING_VALUE` refusal for **every** family git proves it dies on that a tsgit command reaches — across both lazy and eager dies:

- `branch.*.merge`/`remote` — eager within `pull` (ADR-349), not only the refusal path.
- `remote.*.pushUrl` — extend the existing `['url']` guard to `['url','pushurl']` at both `fetch` and `push`.
- `merge.*.driver`/`name` — guard lazily at the merge that resolves `merge=<driver>` (ADR-347).
- `core.excludesFile`/`attributesFile`/`hooksPath` — eager guard on the config-read hot path (ADR-348).

`submodule.*.url`/`update` is **excluded** — pinned S1/S2 prove git does not die; there is no faithful refusal to add.

The wholly-**absent** case is untouched everywhere (`NO_UPSTREAM_CONFIGURED`, `REMOTE_NOT_CONFIGURED`, hook/ignore/attributes silent fallback) — a pre-existing divergence; only the **valueless** case gains the refusal.

## Consequences

### Positive

- Closes the remaining string-typed valueless divergence in one PR — no further follow-ups for these families.
- Every family reuses the single `findFirstValuelessEntry` primitive + `CONFIG_MISSING_VALUE` error (ADRs 327–328): no new error code, no `ParsedConfig` change.

### Negative

- Two families (`core` path-likes, `branch.*` eager die) require an **eager** guard — a refusal on the config-read/command hot path that today never throws on valueless. Larger blast radius and a real behaviour change (silent fallback → refusal); the cost is accepted for full faithfulness. Detailed in ADRs 348–349, which must avoid regressing the absent/empty cases.

### Neutral

- Int-typed valueless shape stays out of reach (ADR-329) — blocked on an int key existing in `ParsedConfig`; unchanged.
