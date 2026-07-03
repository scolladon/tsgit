# 448 — Signed-tag signature is appended to the tag body

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-226 (git-faithfulness), ADR-134 (round-trip property tests)
- **Decision class:** D-faithfulness (adopted-as-recommended, no user judgment)

## Context

`src/domain/objects/tag.ts` currently models an optional `gpgSignature` as a `gpgsig`
*continuation header* (`tag.ts:143-145`). This is a latent faithfulness bug: real
`git tag -s` does **not** use a header — it **appends** the ASCII-armored signature block
to the tag **message body**. The signed payload is the tag object up to and including the
message (`…message\n`); the final object is that payload with the armor concatenated after.
(Commits differ — they *do* use a `gpgsig` header; only tags append to the body.)

## Options considered

1. **Fold the armor into `TagData.message`** — store the signature inside the message
   field. Cheap, but conflates the user's message with the signature and loses the
   structured boundary.
2. **Redesign `serializeTagContent`/`parseTagContent`** *(design recommendation)* — a set
   `gpgSignature` is appended to the body on serialize; `parseTagContent` peels a trailing
   armor block back into `gpgSignature`. Keeps parse/serialize a faithful round-trip pair
   and removes the header path.
3. **Dedicated signed-tag serializer in the primitive** — special-case signing outside the
   domain object; leaves the buggy header path in place.

## Decision

**Option 2, adopted as recommended (no user judgment).** The tag domain object appends a set
`gpgSignature` to the body on serialize and peels it on parse; the erroneous `gpgsig`-header
path is removed. A `*.properties.test.ts` sibling proves the round-trip
(`parse(serialize(x)) ≡ x`) per the property-testing mandate (ADRs 134–136), alongside the
literal example test.

## Consequences

### Positive
- Fixes the faithfulness bug at the root; signed-tag bytes match git exactly.
- Round-trip is provable and property-tested.

### Negative
- Touches the shared tag serializer/parser (used by tag reads), so the change must preserve
  existing lightweight/annotated-read behavior — covered by the existing example tests.

### Neutral
- Aligns the tag path with the pinned byte layout (payload ends `message\n`; final =
  payload + armor).
