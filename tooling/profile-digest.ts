// Parses a `node --prof-process` digest string into normalised tsgit-frame
// self-shares, and (for write commands) partitions those frames into
// "command" vs "setup" work per the scratch-repo build path.

export type FrameShare = { readonly frame: string; readonly self: number; readonly ticks: number };

export type DigestPartition = {
  readonly hotShares: ReadonlyArray<FrameShare>;
  readonly setupShares?: ReadonlyArray<FrameShare>;
  /** Sum of ticks over every extracted tsgit frame — the denominator the shares were computed from. */
  readonly totalTicks: number;
  readonly underSampled: boolean;
};

// Below this many surviving ticks, a share vector rests on too few samples to
// trust its ranking — commands under the floor are flagged, not hidden.
export const UNDER_SAMPLED_TICK_FLOOR = 500;

// Frames on the build-only path (repo creation: `openRepository` → `init` →
// `bootstrapRepository`, plus the transitive layout/path-discovery machinery
// `openRepository` walks to find the git dir) that no write command under
// measurement reaches itself — every measured command runs against an
// already-open, already-initialised scratch. Widened (rather than kept to the
// three top-level names) because `--prof-process`'s flat self-time table
// attributes a helper's ticks to the helper's own frame, not its caller — a
// three-name list left every transitive open/layout helper misclassified as
// command cost for the one write workload (`add`) whose build genuinely
// cannot be hoisted out of the sampled loop (see `profile.ts`). Deliberately
// excludes shared object-write primitives (`writeObject`, `writeTree`, …)
// that BOTH the scratch build and the measured command call — those stay in
// `hotShares` so a write command's cost is never under-reported.
export const SETUP_FRAMES: ReadonlySet<string> = new Set([
  'openRepository',
  'init',
  'bootstrapRepository',
  'findLayout',
  'dirChain',
  'normalizeSeparators',
  'isContainedIn',
  'runFs',
  'createSingleFlightIndexResolver',
  'cachedParentRealpath',
  'assertTrusted',
  'assertRepository',
]);

const NOISE_FLOOR_SELF = 0.01;

// A tsgit frame line has the shape `<ticks> <total%> <nonlib%> <symbol> <location>`.
// Only lines whose location resolves into the profiled tsgit bundle
// (`dist-profile/esm/…`, the names-preserved build the profiler imports) are
// frames we own; everything else (shared libraries, node internals,
// Builtin:/Stub:/RegExp: entries, the Unaccounted/Summary rollups) is noise.
// The `[*~^+]?` strips V8's tier markers (optimised `*` / unoptimised `~` / `^`
// / `+`) so a function is one frame regardless of the tier it was sampled in —
// a JS identifier can never start with one of these, so stripping is safe.
const TSGIT_FRAME_LINE =
  /^\s*(\d+)\s+[\d.]+%\s+[\d.]+%\s+(?:\S+:\s+)?[*~^+]?(\S+)\s+.*dist-profile\/esm\//;

const extractTsgitFrames = (digestText: string): Array<{ frame: string; ticks: number }> =>
  digestText
    .split('\n')
    .map((line) => TSGIT_FRAME_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ frame: match[2] as string, ticks: Number(match[1]) }));

// V8 lists a function once per code location it was seen at (interpreter vs
// optimised tiers), so the same frame name can appear on several lines. Sum
// their ticks so a function's true share is one entry, never split across rows.
const sumByFrame = (
  frames: ReadonlyArray<{ frame: string; ticks: number }>,
): Array<{ frame: string; ticks: number }> => {
  const totals = new Map<string, number>();
  for (const { frame, ticks } of frames) {
    totals.set(frame, (totals.get(frame) ?? 0) + ticks);
  }
  return [...totals].map(([frame, ticks]) => ({ frame, ticks }));
};

type NormalisedShares = { readonly shares: ReadonlyArray<FrameShare>; readonly totalTicks: number };

const normaliseShares = (
  frames: ReadonlyArray<{ frame: string; ticks: number }>,
): NormalisedShares => {
  const totalTicks = frames.reduce((sum, f) => sum + f.ticks, 0);
  if (totalTicks === 0) {
    return { shares: [], totalTicks };
  }
  const shares = frames
    .map((f) => ({
      frame: f.frame,
      self: Math.round((f.ticks / totalTicks) * 100) / 100,
      ticks: f.ticks,
    }))
    .filter((share) => share.self >= NOISE_FLOOR_SELF)
    .sort((a, b) => b.self - a.self);
  return { shares, totalTicks };
};

export const parseDigest = (digestText: string): DigestPartition => {
  const { shares, totalTicks } = normaliseShares(sumByFrame(extractTsgitFrames(digestText)));
  return { hotShares: shares, totalTicks, underSampled: totalTicks < UNDER_SAMPLED_TICK_FLOOR };
};

export const partitionWriteDigest = (
  digestText: string,
  setupFrames: ReadonlySet<string> = SETUP_FRAMES,
): DigestPartition => {
  const { hotShares, totalTicks, underSampled } = parseDigest(digestText);
  return {
    hotShares: hotShares.filter((share) => !setupFrames.has(share.frame)),
    setupShares: hotShares.filter((share) => setupFrames.has(share.frame)),
    totalTicks,
    underSampled,
  };
};
