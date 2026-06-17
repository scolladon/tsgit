# ADR-353: First int-typed config key — `core.loosecompression`/`core.compression` via a faithful `git_config_int`, honoured at loose-object write

## Status

Accepted (2026-06-17)

- **Design:** `docs/design/int-config-valueless-refusal.md`
- **Refines:** ADR-329 (which recorded int-typed parity as *blocked* on an int key existing), ADR-315 (D4 — valueless fields merge as absent)

## Context

The int-typed valueless refusal could not be built because **no int-typed config key was consumed in `ParsedConfig`** — every field was boolean / string / string-list, and no numeric/unit parsing existed anywhere in `src` (the explicit blocker in ADR-329 §Neutral). Rather than ship an unreachable refusal (dead code), the prerequisite is bundled: introduce the first genuinely-consumed int-typed key alongside the refusal.

A genuine consuming site must be a behaviour git actually has, not an invented one. Three candidates were weighed, pinned against git 2.54.0:

- `core.loosecompression` (fallback `core.compression`) — git reads it via `git_config_int` and applies the zlib level on every loose-object write; its valueless death rides the **same** eager-broad `[core]` operational surface 24.9r's gate already covers (pinned identical to `excludesfile`/`attributesfile`).
- `core.repositoryformatversion` — git reads it via `git_config_int` at repo setup, but tsgit only *writes* it; consuming it would add a brand-new repo-open gate, its valueless death has **no** porcelain bypass (even `config --list` dies), and its valid path needs a separate `Expected git repo version` validation shape.
- Any other int key (`core.abbrev`, `core.bigFileThreshold`, `gc.*`, `pack.*`) — none is consumed by tsgit today, so each equally invents a site with no gate to reuse.

`tsgit` is zero-dependency and its loose disk bytes are **out of the byte-identity contract** (`loose-object-interop.test.ts`: equivalence-under-readback — git's loose default is zlib level 1 / header `7801`, Node's default is level 6 / header `789c`; the SHA is over the decompressed payload). The `Compressor` port `deflate(data)` carries no level, and only `NodeCompressor` (`deflateSync`) *can* set one — the Web `CompressionStream` used by the memory/browser adapters exposes no level parameter.

## Options considered

1. **`core.loosecompression`/`core.compression` consumed at loose-object write** (designer's recommendation) — pros: reuses the proven 24.9r eager-broad gate verbatim, real always-exercised behaviour, localized `ParsedConfig` widening; cons: widens the `Compressor` port with a level that two of three adapters cannot honour.
2. **`core.repositoryformatversion` read+validated at repo open** — pros: no port change; cons: largest new surface (a repo-open gate tsgit lacks), no porcelain bypass to reuse, an extra version-validation error shape.
3. **Another int key** — pros: none; cons: no consumed site exists, so it invents one with no gate to reuse.

## Decision

**Option 1.** Add the first int-typed field `ParsedConfig.core.looseCompression: number`, resolved from `core.loosecompression` with `core.compression` as the fallback source (precedence pinned: `loosecompression` > `compression` > git's `Z_BEST_SPEED` default).

A new application primitive `parseGitInt` (sibling of `parseGitBoolean`, in `config-read.ts`) implements git's `git_config_int` → `git_parse_signed` grammar faithfully: base-0 `strtoimax` over the leading-whitespace-trimmed value (decimal, `0x` hex, leading-`0` octal, `+`/`-` sign), then at most one trailing `k`/`m`/`g` unit (case-insensitive, ×1024ⁿ — `t`/`T` is **not** accepted by git 2.54.0); any other trailing byte or no digits consumed (including empty) → `invalid unit`; magnitude exceeding the signed 64-bit `strtoimax` range after scaling → `out of range` (the significant-digit length is bounded before the BigInt conversion so a hostile config value cannot stall the parser). Per **decision 4 = (b)** this is a *complete* generic int parser (both `invalid unit` and `out of range`); the **consumer-specific** `bad zlib compression level` range-check is deferred as a follow-up (it is a zlib-domain check, not int parsing).

The valid level is **honoured on every adapter that can** (**decision 3 = (b)**). Under the zero-dependency invariant that resolves to: `NodeCompressor.deflate` passes `{ level }` to `deflateSync`; the memory and browser adapters accept the `level` parameter and ignore it (the Web `CompressionStream` has no level, and pulling in a userland deflate would break zero-deps). This preserves the existing equivalence-under-readback contract for those adapters exactly. The level is read only at `write-object.ts` (loose write); `build-pack.ts` stays on the no-level `deflate` because git's pack path uses `pack.compression`, a different key (out of scope).

The `Compressor` port becomes `deflate(data, level?)` — `level` optional so the no-level pack call site and the level-less adapters are unaffected.

**Deferred-refusal safety:** because the `bad zlib compression level` check is deferred (decision 4 = b) while the level *is* honoured (decision 3 = b), a value that is a valid integer but outside zlib's `-1..9` domain (e.g. `99`) would otherwise reach `deflateSync` and throw an unstructured `RangeError`. The honouring site therefore applies the level only when it lies in zlib's valid domain and falls back to the adapter default otherwise — never crashing. This is a **documented under-refusal**: git *dies* on `loosecompression=99`; tsgit currently accepts it as the default level. The faithful death is the deferred follow-up.

## Consequences

### Positive

- `ParsedConfig` gains its first int-typed field, unblocking ADR-329's deferred int parity (the refusal lands in ADR-354).
- `parseGitInt` is a complete, reusable, property-testable faithful int parser — every future int key (`bigFileThreshold`, `gc.*`, …) is now one branch + one call away.
- The valid level changes real loose-object bytes on the production (Node) adapter, verified against git's pinned `78da` (level 9) — the prerequisite is genuinely consumed, not invented.

### Negative

- The `Compressor` port gains an optional `level` parameter across all three adapters, two of which deliberately ignore it (documented). `reports/api.json` gains the public `looseCompression` field.

### Neutral

- "Honour on all adapters that can" resolves to Node-only honouring today; if a zero-dependency level-capable Web-Streams API ever appears, the memory/browser adapters honour it then with **no API change**.
- Out-of-zlib-range valid integers are an accepted, documented under-refusal until the `bad zlib compression level` follow-up lands; pack-write compression-level keys (`pack.compression`) are untouched.
- Loose disk bytes remain equivalence-under-readback across adapters — the cross-adapter level gap is faithful, not a divergence.
