# 627 — Boolean config values are refused as git refuses them

- **Status:** accepted — **ratified (user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-4) · **Refines:** ADR-226 · **Deviates from the design recommendation**

## Context

git refuses a non-boolean value for a boolean config key with exit 128
(`fatal: bad boolean config value 'maybe' for 'pack.writeReverseIndex'`, pinned in the
design's Pin D7). tsgit's `parseGitBoolean` is uniformly lenient — any non-true string
coerces to `false` — for every boolean key it reads (`core.bare`, `commit.gpgSign`, …).

The design recommended staying lenient for `pack.writeReverseIndex` with the divergence
recorded, arguing per-key strictness makes one key behave unlike its neighbours and a
repo-wide fix is a separate, sizeable entry.

## Decision

**Repo-wide strict boolean refusal, in this change.** The user ratified the git-faithful
posture over the design's convenience recommendation: a non-boolean value for any boolean
config key tsgit consumes is refused with a typed error carrying the key and the raw
value, matching git's refusal condition (the transcript wording is tsgit's own per
ADR-249's data-not-rendering split). Both narrower alternatives — lenient with a recorded
divergence, or strictness for `pack.writeReverseIndex` alone — were rejected: the first
preserves a known unfaithfulness, the second trades one inconsistency for another.

git's boolean grammar is adopted exactly: `true`/`yes`/`on`/`1` (and a valueless key) are
true; `false`/`no`/`off`/`0` (and the empty value) are false; case-insensitive; anything
else refuses.

## Consequences

- Every boolean config consumer in `src/` moves from lenient coercion to the strict
  parse; each affected key's refusal is pinned against real git in interop tests.
- The design doc's §D6 and interop row X7 are revised: X7 becomes a both-tools-refuse
  faithfulness row instead of a divergence row.
- Malformed-config repositories that tsgit previously limped through now refuse loudly,
  as git does — a behaviour change that is the point, not a regression.
