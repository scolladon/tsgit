# ADR-300: New hooks ship by extending the `HookName` union + inserting calls

## Status

Accepted (at `b3c53efa`)

## Context

Phase 17.2 built the hook subsystem deliberately so that "a future phase adds
one by extending the `HookName` union and inserting one call — no structural
change" (`design/hooks.md` §1, ADR-065). 24.8 is that future phase: six new
client-side hooks across `commit` / `merge` / `checkout` / `rebase`.

The question is whether to honour that design — a flat union widening plus
per-command call insertions — or to introduce structure now (e.g. a hook
registry, a per-hook descriptor table, a "hook policy" object) anticipating
further growth.

## Decision

Honour 17.2's design exactly. The **only** domain change is widening the
`HookName` union by six literals. The port (`HookRunner` / `HookRequest` /
`HookResult`), both adapters (Node / memory), `resolveHooksDir`, and the
`HOOK_FAILED` factory are **unchanged** — they are hook-name-agnostic by
construction. Each command gains the appropriate `runHook` /
`runInformationalHook` call at its faithful firing site.

No registry, no descriptor table, no policy object. The two axes that actually
vary — (a) blocking vs informational exit handling, (b) the per-hook args/stdin
payload — are captured by the **two** primitive entry points (`runHook` /
`runInformationalHook`, ADR-301) and by each call site passing its own
`{ args, stdin }`. A registry would centralise nothing that is duplicated:
every hook's args/stdin are computed from command-local state (the merge result
kind, the rewritten-pair list, the checkout old/new oids) that no table could
hold.

## Consequences

### Positive

- Minimal blast radius: one domain union, a handful of call insertions, one new
  non-throwing primitive. No port/adapter/facade change.
- The widened union flows automatically through `HookRequest.name` and
  `HOOK_FAILED.hook` — both additive, non-breaking.

### Negative

- The firing sites are distributed across the command modules rather than
  centralized. This is the correct locus: a hook fires *as part of* its
  command's lifecycle, with command-local arguments; centralizing the call
  would force command state outward for no gain.

### Neutral

- `reports/api.json` regenerates because the union literals are part of the
  public type surface (as the original three already are) — a large but purely
  mechanical typedoc-id diff, committed with the change.
