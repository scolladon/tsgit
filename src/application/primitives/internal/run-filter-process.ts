import { concatBytes } from '../../../domain/objects/encoding.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  encodePktLine,
  encodePktStream,
  FLUSH_PKT,
  MAX_PKT_LINE_PAYLOAD,
} from '../../../domain/protocol/pkt-line.js';
import type { CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import { getSpawnCwd } from '../path-layout.js';
import type { FilterDriverResult } from '../run-filter-driver.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** git's `start_multi_file_filter_fn` handshake: the client greeting, then
 *  every capability it knows. */
const CLIENT_GREETING = ['git-filter-client\n', 'version=2\n'];
const CLIENT_CAPABILITIES = ['capability=clean\n', 'capability=smudge\n', 'capability=delay\n'];
const SERVER_GREETING = ['git-filter-server', 'version=2'];
const CLEAN_CAPABILITY = 'capability=clean';
const SUCCESS = 'success';
const STATUS_PREFIX = 'status=';

/** The pkt-line frames that carry `bytes`, each at most one payload long. */
const contentFrames = (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_PKT_LINE_PAYLOAD) {
    frames.push(encodePktLine(bytes.subarray(offset, offset + MAX_PKT_LINE_PAYLOAD)));
  }
  return frames;
};

const textStream = (lines: ReadonlyArray<string>): Uint8Array =>
  encodePktStream(lines.map((line) => ENCODER.encode(line)));

/** Everything git writes to a process filter for one clean, in order. */
const cleanRequest = (path: FilePath, bytes: Uint8Array): Uint8Array =>
  concatBytes([
    textStream(CLIENT_GREETING),
    textStream(CLIENT_CAPABILITIES),
    textStream(['command=clean\n', `pathname=${path}\n`]),
    ...contentFrames(bytes),
    FLUSH_PKT,
  ]);

const HEX_LENGTH = /^[0-9a-f]{4}$/i;
const LENGTH_BYTES = 4;
const FLUSH_LENGTH = 0;

/**
 * The response's flush-terminated sections, or `undefined` when a frame is
 * malformed — a bad or reserved length, or a frame running past the end:
 * git's `packet_read` failing on the filter's output.
 */
const responseSections = (
  stdout: Uint8Array,
): ReadonlyArray<ReadonlyArray<Uint8Array>> | undefined => {
  let current: Uint8Array[] = [];
  const sections = [current];
  let offset = 0;
  while (offset < stdout.byteLength) {
    const length = frameLength(stdout, offset);
    if (length === FLUSH_LENGTH) {
      current = [];
      sections.push(current);
    } else if (length < LENGTH_BYTES || offset + length > stdout.byteLength) return undefined;
    else current.push(stdout.subarray(offset + LENGTH_BYTES, offset + length));
    offset += Math.max(length, LENGTH_BYTES);
  }
  // What follows the last flush is unterminated: git never reads it as a section.
  return sections.slice(0, -1);
};

/** The frame's declared length, or `-1` when its header is not four hex digits. */
const frameLength = (stdout: Uint8Array, offset: number): number => {
  const header = DECODER.decode(stdout.subarray(offset, offset + LENGTH_BYTES));
  return HEX_LENGTH.test(header) ? Number.parseInt(header, 16) : -1;
};

const lines = (section: ReadonlyArray<Uint8Array> | undefined): ReadonlyArray<string> =>
  (section ?? []).map((payload) => DECODER.decode(payload).replace(/\n$/, ''));

/** `subprocess_read_status`: the section's last `status=`, else `previous`. */
const statusOf = (section: ReadonlyArray<Uint8Array> | undefined, previous: string): string =>
  lines(section)
    .filter((line) => line.startsWith(STATUS_PREFIX))
    .reduce((_, line) => line.slice(STATUS_PREFIX.length), previous);

const greetedAsCleaner = (
  greeting: ReadonlyArray<Uint8Array> | undefined,
  capabilities: ReadonlyArray<Uint8Array> | undefined,
): boolean => {
  const greetingLines = lines(greeting);
  return (
    greetingLines.length === SERVER_GREETING.length &&
    greetingLines.every((line, index) => line === SERVER_GREETING[index]) &&
    lines(capabilities).includes(CLEAN_CAPABILITY)
  );
};

/** The cleaned bytes from a well-formed, successful response — git reads an
 *  end of file before any flush it waits on as a failure. */
const cleanedContent = (
  sections: ReadonlyArray<ReadonlyArray<Uint8Array>>,
): Uint8Array | undefined => {
  const [greeting, capabilities, status, content, trailingStatus] = sections;
  if (!greetedAsCleaner(greeting, capabilities) || statusOf(status, '') !== SUCCESS)
    return undefined;
  if (content === undefined || trailingStatus === undefined) return undefined;
  return statusOf(trailingStatus, SUCCESS) === SUCCESS ? concatBytes(content) : undefined;
};

/**
 * git's `apply_multi_file_filter` for one clean, over a single run of the
 * `filter.<d>.process` command: the v2 handshake, the request and its
 * content are written up front, and the response is read once the process
 * exits — git keeps one process per driver across paths, this runs one per
 * clean. A failed handshake, a missing clean capability, a non-success
 * status or a malformed frame all fail the clean, as in git.
 */
export const runFilterProcess = async (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  path: FilePath,
  bytes: Uint8Array,
): Promise<FilterDriverResult | { readonly ok: false; readonly exitCode: undefined }> => {
  const result = await runner.run({
    command,
    cwd: getSpawnCwd(ctx.layout),
    env: { GIT_DIR: ctx.layout.gitDir },
    stdin: cleanRequest(path, bytes),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  const sections = responseSections(result.stdout ?? new Uint8Array(0));
  const cleaned = sections === undefined ? undefined : cleanedContent(sections);
  if (cleaned !== undefined) return { ok: true, bytes: cleaned };
  // A long-running filter's own exit status is never what git checks; it is
  // reported only when it explains an unusable response.
  return { ok: false, exitCode: result.exitCode === 0 ? undefined : result.exitCode };
};
