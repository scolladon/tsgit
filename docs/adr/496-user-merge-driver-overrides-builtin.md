# 496 — A user-configured merge driver overrides the built-in of the same name

- **Status:** accepted (user judgment — chose all three built-in names, the git-faithful scope)
- **Date:** 2026-07-23
- **Design:** docs/design/merge-driver-config-override.md · **Supersedes/Refines:** refines ADR-303

## Context

ADR-303's driver-selection table maps the resolved `merge` attribute values `text`, `binary`,
and `union` **unconditionally** to their built-in strategies. The implementation
(`namedChoice` in `resolve-merge-driver.ts`) mirrored that: it returned the built-in for those
three names **before** ever reading config, so a repo configuring `[merge "text"] driver = <cmd>`
on a path carrying `merge=text` ran the built-in text merge and never the configured command.

Git does the opposite. `find_ll_merge_driver` (`merge-ll.c`) scans **user-configured**
`[merge "<name>"]` drivers (`ll_user_merge`) **first**, and only falls through to the built-in
name table (`ll_merge_drv[]`) when no user driver of that name exists — so a configured driver
of *any* name, including the three built-ins, wins. Pinned empirically on git 2.55.0 (design
matrix M1/M2/M3: `text`, `binary`, and `union` are each config-overridable identically). The
divergence left two mutants on the old line 30 (`if (name === 'text') return TEXT`) unkillable,
because a faithful kill test fails against pre-fix behaviour — the 26.12 mutation sweep surfaced
the bug.

## Options considered

1. **All three built-ins consult config first** (chosen; the design's recommendation) — faithful
   to `find_ll_merge_driver`, symmetric, minimal branching. / cons: widens the fix beyond the
   backlog's literal "text".
2. **`text`-only** — matches the backlog's literal wording. / cons: knowingly leaves `merge=binary`
   and `merge=union` + a configured same-name driver divergent (M2/M3), and would require
   re-touching this function when they are fixed later.

## Decision

`namedChoice(ctx, name)` consults `[merge "<name>"].driver` for the resolved driver name **first**.
A configured `driver` command yields an external driver (`{ kind: 'external', command, name? }`);
only when no driver command is configured does resolution fall back to the built-in **selected by
name** — `binary` → binary, `union` → union, `text` or any unknown name → text. Precedence is
user config **before** built-in, uniformly for all three built-in names, matching git.

The boolean/macro paths are unchanged and consult **no** config: `merge` (`true`) / unspecified →
text; `-merge` / the `binary` macro (`false`) → binary, even when a `[merge "binary"] driver` is
configured (M14). These mirror git's `ATTR_TRUE` / `ATTR_UNSET` / `ATTR_FALSE` direct returns,
which short-circuit before the name lookup.

## Consequences

- User-config precedence is byte-faithful with git for `text`, `binary`, and `union`; pinned by a
  twin-repo `merge-driver-interop` case per built-in name.
- The two unkillable line-30 mutants are removed with the short-circuit; the relocated
  `binary`/`union` guards are killed by the existing built-in-fallback cases.
- No public API change — `resolvePathMergeSpec`'s signature is untouched, `namedChoice` is
  file-private.
- Refines ADR-303's unconditional `text`/`binary`/`union` rows: each now reads "consult config for
  a same-named driver first; built-in only when unconfigured."
- Off-node (no `CommandRunner`), a configured override resolves to `{ kind: 'external' }` and falls
  back to the built-in text merge — the same inert behaviour any external driver already has there
  (ADR-304/408); on-node, where the faithfulness suite runs, the driver executes.
