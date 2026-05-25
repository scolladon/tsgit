# ADR-145: Runtime drivers live in `test/runtime-parity/`, not `test/parity/`

## Status

Accepted (at `4911c0d`)

## Context

After 19.5, `test/parity/` holds:

- `fixtures.ts` and `scenarios/**` — the *scenarios* the parity contract
  defines.
- `node.test.ts`, `memory.test.ts` — Vitest *drivers* that iterate the
  scenarios against the Node and Memory adapters.

A natural option for 19.8 is to add new driver files alongside the
existing ones:

```
test/parity/
├── scenarios/
├── node.test.ts                  # existing
├── memory.test.ts                # existing
├── deno-node.test.ts             # new — Deno × Node adapter
├── deno-memory.test.ts           # new — Deno × Memory adapter
├── bun-node.test.ts              # new
├── bun-memory.test.ts            # new
└── workers-memory.test.ts        # new
```

Two problems:

1. **Tool coupling.** Deno files use `Deno.test`; Bun files use
   `bun:test`; Workers files use Vitest-via-workerd. The Vitest config
   for the `parity` project would have to exclude five out of seven
   files, leaving only the original two — a sign the directory has
   absorbed responsibilities Vitest can't naturally express.
2. **Audit-scope drift.** The 19.5 audit
   (`tooling/audit-parity-fixtures.ts`) globs
   `test/parity/scenarios/**`. The Vitest tests are pure drivers and are
   intentionally outside the audit scope. Adding Deno/Bun/Workers
   drivers to the same directory would tempt future audit extensions
   ("also scan the drivers!") that work for Vitest but break for the
   other frameworks.

## Decision

Runtime drivers live in a sibling directory:

```
test/runtime-parity/
├── deno/
│   ├── deno.json
│   ├── parity-node.test.ts
│   └── parity-memory.test.ts
├── bun/
│   ├── bunfig.toml
│   ├── parity-node.test.ts
│   └── parity-memory.test.ts
└── workers/
    ├── wrangler.jsonc
    ├── vitest.config.ts
    ├── tsconfig.json
    └── parity-memory.test.ts
```

Each subdirectory holds its runtime-specific config + driver files. The
shared scenario registry lives at `test/parity/scenarios/` (unchanged);
drivers import via relative path
(`../../parity/scenarios/index.ts`).

`test/parity/` keeps its 19.5 shape: scenarios + Vitest drivers + the
audit it gates.

## Consequences

### Positive

- Vitest config for the `parity` project stays a one-line `include:
  ['test/parity/**/*.test.ts']` — no per-runtime exclusion list.
- Each runtime's tooling config (`deno.json`, `bunfig.toml`,
  `wrangler.jsonc`) lives next to the tests it serves; no cross-runtime
  config pollution.
- The audit's scope stays "scenarios" (deterministic, pure), unaffected
  by drivers (which legitimately call platform primitives).
- New runtimes drop into their own directory; existing layout doesn't
  reshape per addition.

### Negative

- Two top-level directories (`test/parity/` and `test/runtime-parity/`)
  describe related concepts. Mitigated by a one-paragraph note at the
  top of each directory's first scenario / driver file pointing at the
  other.
- A reader looking for "all parity tests" must check both directories.
  CONTRIBUTING.md gains one sentence to spell that out.

### Neutral

- The naming `test/runtime-parity/` reads naturally: "tests that prove
  the *runtimes* are at parity". `test/parity/` reads as: "tests that
  prove the *adapters* are at parity". Different axis, different
  directory.
