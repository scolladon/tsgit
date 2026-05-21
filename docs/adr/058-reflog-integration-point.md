# ADR-058: Reflog write integration — automatic logging in the ref-write primitives

## Status

Accepted (at `1e5f20b`)

## Context

The reflog (Phase 17.1) must capture **every** ref and HEAD movement. The
question is *where* the reflog entry is written and *how much* each caller has
to do.

Two shapes were considered:

- **(a) Caller-driven intent.** `updateRef` takes a `ReflogIntent`
  (`{ message, identity }`) or an explicit `null`; each command resolves
  identity, checks the enable gate, and threads the intent in. The first design
  draft chose this — a *required* option makes the type checker refuse any
  call site that forgets to decide.
- **(b) Automatic logging.** The ref-write primitive logs by itself — reads
  config, applies the gate, resolves identity — and the caller supplies only a
  human-readable *message*.

Canonical git is unambiguously **(b)**: a ref update logs itself as part of the
ref transaction, gated by `core.logAllRefUpdates`; builtins only pass a reason
string (`commit:`, `checkout: moving from …`). Shape (a) pushed git's automatic
behaviour onto every call site and invented an opt-out (`null`) git does not
have.

The obstacle to (b): `updateRef` is a tier-2 primitive, and making it
self-sufficient means reading `.git/config` — but `config-read.ts` currently
lives in `application/commands/internal/`. A primitive importing from the
command tier is a hexagonal-layering inversion.

## Decision

Adopt **(b)**, git-faithful automatic logging.

- A new primitive `recordRefUpdate(ctx, ref, oldId, newId, message)` is the
  **single** reflog writer. It self-gates (§ADR-063), self-resolves identity
  (§ADR-061), sanitises the message, and appends one entry.
- `updateRef` logs automatically: after a write it calls `recordRefUpdate` for
  the ref, plus a coupled HEAD entry (§ADR-059). Its options become a
  discriminated union — the **write** arm requires `reflogMessage: string`
  (git's builtins always supply one); the **delete** arm does not.
- `config-read.ts` **relocates** from `application/commands/internal/` to
  `application/primitives/`, so a primitive can read config without inverting
  the layer graph. Config reading is a low-level repo-file operation and
  belongs in the primitive tier regardless.

## Consequences

### Positive

- Faithful to git's transaction-logs-itself model.
- Simpler than (a): no `ReflogIntent` type, no `buildReflogIntent`, no
  per-command intent plumbing or `null` opt-out. A command's only duty is to
  pass a message.
- One chokepoint — every writer funnels through `recordRefUpdate`, so the gate
  and format live in exactly one place.
- A required `reflogMessage` on the write arm still gives a compile-time
  guarantee that each ref write states *why* it moved.

### Negative

- Breaking change to the `updateRef` signature (new required field on the
  write arm). Acceptable: Phase 17.x targets v2.0 (major). Recorded in
  `MIGRATION.md`.
- The `config-read` relocation changes import paths at ~6 existing consumers.
  Mechanical; `tsc` + dependency-cruiser catch any miss.

### Neutral

- `recordRefUpdate` reads `.git/config` via `readConfig`, which is cached
  per-`Context` (single-flight `WeakMap`) — negligible cost.
