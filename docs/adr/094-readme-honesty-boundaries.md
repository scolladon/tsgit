# ADR-094: README honesty boundaries

## Status

Proposed.

## Context

The pre-restructure README contained four classes of claims that exceeded what CI today verifies:

1. **Runtime claims** — "runs on Node.js, browsers, Deno, Bun, Cloudflare Workers". CI today exercises Node + Browser (Playwright) + in-memory. Deno, Bun, and Workers are untested. A user invoking `import @scolladon/tsgit` from `wrangler dev` discovers this on their own.
2. **Performance claims** — "3-5x faster than isomorphic-git via fanout binary search, …". `reports/benchmarks/summary.md` (committed) shows tsgit beats iso-git on `status:dirty-25-files` by ~2×, is at parity on `clone` and `readBlob:warm`, and is **slower** on `log:walk-50-commits` (~0.66×) and `readBlob:cold-cache` (~0.67×). "3-5×" is an aspiration, not a measurement.
3. **Bundle size claims** — `MIGRATION.md` cites "~86 KiB gzipped (full library)" against iso-git's "~250 KiB gzipped". `.size-limit.json` enforces a **260 KB** ceiling for the full library glob and 60 KB for the Node entry. The "86 KiB" number is not regenerable from any committed report.
4. **Competitor comparisons** — competitor benchmark numbers were quoted without methodology. Sources were not regenerable.

Each overclaim sets up a future credibility loss: a user who measures their own bundle, runs their own benchmark, or tries Bun discovers the gap and reads every other claim with suspicion.

## Decision

The README states **only** facts that meet all three criteria:

1. **Tested today** — there is a CI job, a committed report, or an enforced configuration that produces the number.
2. **Self-contained** — no comparison to another library appears in the README.
3. **No aspirational numbers** — only what is currently measured. Roadmap targets live in `docs/understand/performance.md`.

Concretely:

| Claim type | README treatment | Where the deeper claim lives |
|---|---|---|
| Runtime support | "Node + Browser (OPFS) + in-memory" only | Deno + Bun + Workers restored after **19.8** parity matrix is green |
| Bundle size | "Node entry under 60 KB gz (size-limit-enforced)" — cites the enforced ceiling | Real measured bytes + tree-shaken sizes deferred to **26.8** |
| Performance | 6 medians from `reports/benchmarks/summary.md`, as-measured, on a single platform stated explicitly | Methodology, targets, regression history → `docs/understand/performance.md` |
| Competitor comparison | Absent | Side-by-side numbers → `docs/understand/performance.md` after **26.7** |
| Quality | 100% line/branch/function/statement coverage, mutation-tested every PR, cross-platform CI matrix | Same — all assertions are CI-enforced today |

The README's "Why tsgit" section is restructured around **design goals** (qualitative, audience-facing) plus **current measured performance** (quantitative, single platform). There is no "X× faster" headline. There is no honesty asymmetry between sections: wins, parity, and current losses all appear in the deeper `performance.md`, but the README chooses brevity over completeness and points at the deeper page for the full picture.

## Consequences

### Positive

- Every README number is regenerable from a committed artifact. A reviewer can run `cat reports/benchmarks/summary.md` and reproduce the table.
- A user who benchmarks tsgit themselves discovers the same numbers the README quotes — no surprise. Trust compounds.
- The honesty boundary creates back-pressure on the perf roadmap: claims tighten only after **26.8** (bundle measurement scripts) and **26.7** (competitor benchmark suite) make them defensible.
- Restoring the Deno + Bun + Workers runtime claim becomes a CI-gated event (19.8 must be green), not a copywriting choice.

### Negative

- The README reads "smaller" than the pre-restructure version. Pure marketing impact: a reader skimming the README sees fewer "wins". Mitigation: the page that holds the deeper comparison (`docs/understand/performance.md`) is linked from the README at the natural point.
- Restoring removed claims requires a follow-up PR (gated on **19.8** / **26.8** / **26.7** landing). Each gate is an explicit checkpoint, not a copywriting decision.
- A claim already true today (e.g. "tsgit handles `status:dirty` ~2× faster than iso-git on our hardware") is absent from the README in the name of "no competitor mentions". Some accuracy is sacrificed to discipline. The full picture is one click away.

### Neutral

- The boundary is per-page, not per-document: `docs/understand/performance.md` carries the competitor comparison without violating the policy, because the README is the entry point and the place where over-confidence does the most damage. Deeper pages can carry richer comparisons because the reader who reached them is already evaluating tsgit, not deciding whether to read on.
- The convention does not prevent the README from quoting the project's own absolute numbers (it doesn't), nor from naming alternatives in prose where useful for orientation (it does — "isomorphic-git" appears once, in the migration link). The rule is no quantitative comparison and no untested runtime claim.

## Alternatives considered

- **Status quo (keep the aspirational claims)** — rejected for the credibility-compounding reason above.
- **Keep the competitor comparison but cite it more rigorously in-README** — rejected on README-length grounds: a defensible competitive comparison requires methodology paragraphs (`darwin-arm64`, Node version, repo size, methodology) that turn the README into a benchmark report.
- **Move all performance numbers off the README entirely** — rejected because "Why tsgit" with no numbers is a weaker page. The compromise is six absolute medians from the committed bench summary.
- **Quote ranges instead of medians** ("`status:dirty` 1.5 – 2.0 ms") — rejected because the bench summary already quotes ±RME; ranges would compound the noise.
