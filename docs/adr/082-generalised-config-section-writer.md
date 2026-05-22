# ADR-082: Generalise the `[core]`-only config writer to any `[section]`

## Status

Accepted (at `aef8dc2`)

## Context

`update-config.ts` writes `.git/config` by line surgery — it preserves
comments, blank lines, key order, and unrelated bytes, because tsgit has no
general INI writer. ADR-074 deliberately scoped it to the `[core]` section:
sparse checkout only needed to flip `core.sparseCheckout` /
`core.sparseCheckoutCone`.

Partial clone must write three sections:

- `[core] repositoryformatversion = 1` (extensions require config format v1);
- `[remote "origin"]` — `url`, `fetch`, `promisor`, `partialclonefilter`;
- `[extensions] partialClone = origin`.

`[remote "origin"]` also introduces the first **subsectioned** header the
writer must handle. The `[core]`-only writer cannot express any of this.

## Decision

Generalise the writer to
`setConfigEntry(text, section, subsection, key, value)`:

- section name matched case-insensitively (git semantics);
- subsection matched case-sensitively (git semantics);
- find-or-create the section, then replace-or-insert the key — same line
  surgery, now parameterised.

`setCoreConfigEntry(text, key, value)` is kept as a thin wrapper bound to
`('core', undefined)` so the sparse-checkout caller is untouched.
`updateConfigEntries(ctx, entries)` folds `setConfigEntry` over a batch of
`{ section, subsection?, key, value }`. Control-character rejection (which
guards against splicing a forged section) extends to the subsection name.

## Consequences

### Positive

- One writer covers every section partial clone needs, and any future
  section, without a third special-casing.
- Byte-preservation of unrelated config is retained — still line surgery, not
  a parse-and-reserialise.
- Subsection support unblocks all `[remote "<name>"]` /
  `[branch "<name>"]` writes the codebase may later want.

### Negative

- More code than the `[core]` special case: subsection matching, header
  rendering with quoting, an extra control-char guard. Mitigated by exhaustive
  unit tests (new section / existing section / existing key / subsection
  case-sensitivity).

### Neutral

- Still not a general INI writer: no multi-valued keys, no section removal, no
  comment authoring. It writes one `key = value` per call. That is all partial
  clone (and sparse checkout) need; a fuller writer remains unjustified.
- ADR-074's "minimal `[core]` writer" decision is effectively superseded for
  scope, though its core principle — line surgery over reserialise — is
  preserved and extended.
</content>
