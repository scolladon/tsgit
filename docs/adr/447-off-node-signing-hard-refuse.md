# 447 — Off-node signing hard-refuses

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-226 (git-faithfulness), ADR-438 (error taxonomy), ADR-442 (signer reuse)
- **Decision class:** D-faithfulness (adopted-as-recommended, no user judgment)

## Context

`CommandRunner` is absent on the browser and in-memory adapters (no OS process). When a
signature is requested there (via `-S`, `commit.gpgsign`, `tag.gpgSign`, `push.gpgSign`),
the signer has no way to produce one. git never silently drops a requested signature — it
fails the operation.

## Options considered

1. **Hard-refuse with a typed error** *(design recommendation)* — signing requested with
   no `ctx.command` refuses the operation with a typed, off-node error; nothing is written.
2. **Silently skip signing** and write an unsigned object — divergent and a security
   footgun (the user believes the artifact is signed).
3. **Refuse only in-browser**, allow elsewhere — no principled boundary; in-memory equally
   lacks a runner.

## Decision

**Option 1, adopted as recommended (no user judgment).** A signing request without a
`CommandRunner` refuses atomically with a typed error in the ADR-438 taxonomy. This is
forced by the git-faithfulness prime directive (ADR-226): silently emitting unsigned output
would be both a faithfulness and a security divergence.

## Consequences

### Positive
- No silent divergence; the caller learns signing is unavailable rather than trusting an
  unsigned artifact.

### Negative
- Browser/in-memory callers cannot sign; this is a documented platform limitation.

### Neutral
- Symmetric to the existing off-node-inert treatment of filter drivers (ADRs 406–410),
  differing only in that a *requested* signature is an error rather than a no-op.
