// Parses a `node --prof-process` digest string into normalised tsgit-frame
// self-shares, and (for write commands) partitions those frames into
// "command" vs "setup" work per the scratch-repo build path.

export type FrameShare = { readonly frame: string; readonly self: number };

export type DigestPartition = {
  readonly hotShares: ReadonlyArray<FrameShare>;
  readonly setupShares?: ReadonlyArray<FrameShare>;
};

// Frames on the build-only path (`init` → `bootstrapRepository`) that the
// write commands under measurement never reach themselves. Deliberately
// excludes shared object-write primitives (`writeObject`, `writeTree`, …)
// that BOTH the scratch build and the measured command call — those stay in
// `hotShares` so a write command's cost is never under-reported.
export const SETUP_FRAMES: ReadonlySet<string> = new Set(['init', 'bootstrapRepository']);

const NOISE_FLOOR_SELF = 0.01;

// A tsgit frame line has the shape `<ticks> <total%> <nonlib%> <symbol> <location>`.
// Only lines whose location resolves into the profiled tsgit bundle
// (`dist-profile/esm/…`, the names-preserved build the profiler imports) are
// frames we own; everything else (shared libraries, node internals,
// Builtin:/Stub:/RegExp: entries, the Unaccounted/Summary rollups) is noise.
// The `[*~^]?` strips V8's tier markers (optimised / unoptimised / etc.) so a
// function is one frame regardless of the tier it was sampled in.
const TSGIT_FRAME_LINE =
  /^\s*(\d+)\s+[\d.]+%\s+[\d.]+%\s+(?:\S+:\s+)?[*~^]?(\S+)\s+.*dist-profile\/esm\//;

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

const normaliseShares = (frames: ReadonlyArray<{ frame: string; ticks: number }>): FrameShare[] => {
  const totalTicks = frames.reduce((sum, f) => sum + f.ticks, 0);
  if (totalTicks === 0) {
    return [];
  }
  return frames
    .map((f) => ({ frame: f.frame, self: Math.round((f.ticks / totalTicks) * 100) / 100 }))
    .filter((share) => share.self >= NOISE_FLOOR_SELF)
    .sort((a, b) => b.self - a.self);
};

export const parseDigest = (digestText: string): ReadonlyArray<FrameShare> =>
  normaliseShares(sumByFrame(extractTsgitFrames(digestText)));

export const partitionWriteDigest = (
  digestText: string,
  setupFrames: ReadonlySet<string> = SETUP_FRAMES,
): DigestPartition => {
  const shares = parseDigest(digestText);
  return {
    hotShares: shares.filter((share) => !setupFrames.has(share.frame)),
    setupShares: shares.filter((share) => setupFrames.has(share.frame)),
  };
};
