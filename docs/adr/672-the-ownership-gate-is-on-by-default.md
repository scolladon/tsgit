# 672 — The ownership gate is on by default

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D4) · **Refines:** ADR-226

## Context

Following someone else's repository metadata is code execution: `hooks/` in the discovered
common dir spawn with the caller's full `process.env`, `merge.<d>.driver` names a shell command,
and since the bare-repository work a planted `core.worktree = /` collapses the FS validator's
allowlist to `[/]`. tsgit has no gate today. git's default is on.

The cost is real: a caller operating on a container-mounted or shared repository with a
mismatched uid starts throwing on upgrade. This is the friction `safe.directory` is famous for.

## Options considered

1. **ON by default** — `trust` defaults to `'ownership'`, matching git (design recommendation)
   — pros: the prime directive binds, and today's behaviour is a security hole rather than a
   feature / cons: an upgrade breaks mismatched-uid callers until they pass
   `trustedDirectories`.
2. **OFF, opt-in** — pros: no upgrade breakage / cons: ships a security feature nobody turns
   on, and makes the library's default *less* safe than the `git` binary the same user already
   trusts on the same machine.
3. **ON on node, OFF elsewhere** — not a distinct option: ADR-669 already yields it, since
   sandboxes omit the capability.

## Decision

**Option 1 — ratified by the user.**

`trust` defaults to `'ownership'`.

The blast radius is measurably narrower than git's: the **explicit-`gitDir` route is entirely
ungated in git** (measured — `--git-dir`, `GIT_DIR`, and relative forms all pass without a
refusal), and tsgit reproduces that. Callers who pass `gitDir` — the common programmatic shape —
are unaffected. Only the discovery routes are gated.

## Consequences

- A breaking behavioural change for discovery-route callers on foreign-owned repositories; it
  belongs in the release notes, not only in the docs page.
- `trustedDirectories` and `trust: 'always'` are the documented escape hatches, and carry the
  same WARNING register as `hooks` / `command` (ADR-671).
- The default makes ADR-670's Windows gap user-visible as an inconsistency across platforms;
  that is recorded there rather than papered over here.
