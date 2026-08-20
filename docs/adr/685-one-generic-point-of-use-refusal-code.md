# 685 — One generic point-of-use refusal code for accepted-but-unbacked extensions

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/repository-format-acceptance-gate.md (candidate DN-2) · docs/design/sha256-object-format.md (candidate D5) · **Refines:** ADR-667, ADR-668

## Context

ADR-667's standing rule: where tsgit cannot act on an accepted extension, it refuses *precisely,
at the point of use*. Both sibling designs raised the shape of that family independently, so it
is settled once here.

Measurement shrank the family to **exactly one member**. `objectFormat` and `refStorage` are
implemented (ADR-681, ADR-680). `relativeWorktrees` is backed by a one-line pointer resolution,
measured in the revision. `preciousObjects` is honoured by construction — verified against the
whole command surface and every `fs.rm` site; tsgit has no `gc`, `prune` or `repack`. That leaves
`compatObjectFormat`, which git itself refuses on this build
(`fatal: compatibility hash algorithm support requires Rust`).

## Options considered

1. **One generic `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`** (both designs'
   recommendation) — pros: the shape ADR-667's rule describes; a future unbacked name joins by
   name, without a new code / cons: less specific than a dedicated code.
2. **One specific `COMPAT_OBJECT_FORMAT_UNSUPPORTED { value }`** — pros: precise today / cons:
   the family grows a code per name, and today's single member is an accident of how much this
   change implements.
3. **Reuse ADR-668's `REPOSITORY_EXTENSIONS_UNSUPPORTED`** — excluded by ADR-668's own
   consequence, and independently wrong: the two conditions sit on different measured tiers.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`, raised at the point of use — never at
the acceptance gate, which accepts every name git knows (ADR-667).

## Consequences

- Exactly one name reaches it today (`compatObjectFormat`), and the docs row says so while the
  code stays general.
- The distinction from ADR-668's gate codes is tier, not severity: the gate refuses a repository
  git also refuses; this refuses an operation on a repository git accepts.
- If a future extension git adds goes unimplemented, it joins by name with no new code and no new
  ADR — which is the point of the generic shape.
