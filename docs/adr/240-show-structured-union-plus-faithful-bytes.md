# ADR-240: `show` returns a structured union plus the faithful byte stream

## Status

Accepted (at `74395be8`)

## Context

`git show <object>` emits a single text stream whose shape depends on the
resolved object kind (commit → header + message + patch; tag → header +
message + recursed target; tree → listing; blob → raw bytes). A TypeScript
library can surface this three ways:

1. **Structured union + faithful rendering** — a discriminated union on `kind`
   carrying the parsed object data *and* the rendered output git would print.
2. **Pure byte stream** — return only `Uint8Array`; callers re-parse for data.
3. **Pure structured** — return only the parsed union; callers re-implement
   git's formatting (date format, message indentation, `Merge:` line, …).

The backlog item is literally "**formatted** object output", so option 3 fails
the brief — the faithfulness-critical part (matching git's display byte-for-byte)
would be pushed onto every consumer. Option 2 is maximally faithful but throws
away the structured view the rest of the library exposes (`log`, `catFile`,
`diff` all hand back parsed data). The sibling `diff` command already
established the precedent: `{ format: 'patch', text, diff }` returns the
rendered text *and* the structured `TreeDiff`.

A complication: blobs are arbitrary bytes (possibly binary), so a single
`text: string` field cannot faithfully carry every object, and the multi-object
join (ADR-241) concatenates text and binary.

## Decision

`show` returns **both** a per-object structured union and the authoritative
byte stream:

```ts
interface ShowOutput {
  readonly objects: ReadonlyArray<ShowResult>;  // structured, one per input rev
  readonly bytes: Uint8Array;                    // faithful `git show` stream
}
```

`ShowResult` is a `readonly` discriminated union on `kind`. The text-oriented
kinds expose an ergonomic `string`; the blob exposes raw bytes; the tag carries
its target nested:

- `commit` — `{ id, commit: CommitData, patch?, text }` (`text` = the
  self-contained commit block; `patch` omitted for merges).
- `tag` — `{ id, tag: TagData, target: ShowResult, text }` (`text` = the tag
  block only; `target` is the recursively-shown tagged object).
- `tree` — `{ id, entries, text }`.
- `blob` — `{ id, content: Uint8Array }` (no `text`).

`bytes` is the deliverable — the exact stream `git show` prints — and is the
only shape that can faithfully carry binary blobs and the §5 multi-object join.
It is produced by a pure `domain/show/show-stream.ts` renderer that consumes
the precomputed per-object `text` / `content`.

## Consequences

### Positive

- Meets the "formatted output" brief: `bytes` is byte-faithful to `git show`
  and is the single thing parity tests assert against.
- Keeps the structured view the rest of the library offers; callers switch on
  `kind` for typed data without re-parsing.
- Mirrors `diff`'s dual `{ text, diff }` return — one idiom across the surface.
- Additive headroom: `-s`, `--format`, `--stat` slot onto the same shape with
  no breaking change.

### Negative

- Two representations of the same content (`objects[i].text` + the composed
  `bytes`) — mild redundancy, accepted because each serves a distinct need
  (ergonomic per-object string vs faithful binary-safe whole stream).
- The tag variant's `text` is *not* the full `git show <tag>` (it excludes the
  recursed target); callers wanting one object's full stream compose
  `tag.text` + target rendering, or read `bytes`.

### Neutral

- The blob variant is the only one without `text`; that asymmetry reflects that
  blobs are raw bytes, not formatted text.
