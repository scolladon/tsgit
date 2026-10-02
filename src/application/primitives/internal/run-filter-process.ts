import { concatBytes } from '../../../domain/objects/encoding.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import {
  encodePktLine,
  encodePktStream,
  FLUSH_PKT,
  MAX_PKT_LINE_PAYLOAD,
} from '../../../domain/protocol/pkt-line.js';
import type { CommandProcess, CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import {
  convertThroughPool,
  type FilterExchange,
  type FilterProcessOutcome,
  type PktSections,
  type RunningFilter,
} from './filter-process-pool.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** git's `start_multi_file_filter_fn` handshake: the client greeting, then
 *  every capability it knows. */
const CLIENT_GREETING = ['git-filter-client\n', 'version=2\n'];
const CLIENT_CAPABILITIES = ['capability=clean\n', 'capability=smudge\n', 'capability=delay\n'];
const SERVER_GREETING = ['git-filter-server', 'version=2'];
const SUCCESS = 'success';
const STATUS_PREFIX = 'status=';
const CAPABILITY_PREFIX = 'capability=';

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

/** One conversion asked of a process filter. */
export interface FilterProcessRequest {
  readonly capability: 'clean' | 'smudge';
  readonly path: FilePath;
  readonly bytes: Uint8Array;
  /** The blob a smudge checks out — git's `blob=` metadata. */
  readonly blob?: ObjectId;
}

/** Everything git writes to a process filter for one conversion, in order. */
const encodeRequest = ({ capability, path, bytes, blob }: FilterProcessRequest): Uint8Array =>
  concatBytes([
    textStream([
      `command=${capability}\n`,
      `pathname=${path}\n`,
      ...(blob === undefined ? [] : [`blob=${blob}\n`]),
    ]),
    ...contentFrames(bytes),
    FLUSH_PKT,
  ]);

const lines = (section: ReadonlyArray<Uint8Array>): ReadonlyArray<string> =>
  section.map((payload) => DECODER.decode(payload).replace(/\n$/, ''));

/** `subprocess_read_status`: the section's last `status=`, else `previous`. */
const statusOf = (section: ReadonlyArray<Uint8Array>, previous: string): string =>
  lines(section)
    .filter((line) => line.startsWith(STATUS_PREFIX))
    .reduce((_, line) => line.slice(STATUS_PREFIX.length), previous);

const greetsAsServer = (greeting: ReadonlyArray<Uint8Array> | undefined): boolean => {
  if (greeting === undefined) return false;
  const greetingLines = lines(greeting);
  return (
    greetingLines.length === SERVER_GREETING.length &&
    greetingLines.every((line, index) => line === SERVER_GREETING[index])
  );
};

const capabilityNames = (section: ReadonlyArray<Uint8Array>): ReadonlySet<string> =>
  new Set(
    lines(section)
      .filter((line) => line.startsWith(CAPABILITY_PREFIX))
      .map((line) => line.slice(CAPABILITY_PREFIX.length)),
  );

/** git's `start_multi_file_filter_fn`: version, then capabilities, each awaited in turn. */
const handshake = async (
  child: CommandProcess,
  sections: PktSections,
): Promise<ReadonlySet<string> | undefined> => {
  await child.write(textStream(CLIENT_GREETING));
  if (!greetsAsServer(await sections.next())) return undefined;
  await child.write(textStream(CLIENT_CAPABILITIES));
  const advertised = await sections.next();
  return advertised === undefined ? undefined : capabilityNames(advertised);
};

/** `handle_filter_error`'s reading of a non-success status. */
const failureOf = (status: string): FilterExchange => {
  if (status === 'error' || status === 'abort') return { kind: status };
  return { kind: 'broken' };
};

const BROKEN: FilterExchange = { kind: 'broken' };

/** The response after a `success` status: the content, then its trailing status. */
const readContent = async (sections: PktSections): Promise<FilterExchange> => {
  const content = await sections.next();
  const trailing = await sections.next();
  if (content === undefined || trailing === undefined) return BROKEN;
  const status = statusOf(trailing, SUCCESS);
  return status === SUCCESS
    ? { kind: 'converted', bytes: concatBytes(content) }
    : failureOf(status);
};

/** git's `apply_multi_file_filter` conversation for one path. */
const exchange =
  (request: FilterProcessRequest) =>
  async ({ child, sections }: RunningFilter): Promise<FilterExchange> => {
    await child.write(encodeRequest(request));
    const statusSection = await sections.next();
    if (statusSection === undefined) return BROKEN;
    const status = statusOf(statusSection, '');
    return status === SUCCESS ? readContent(sections) : failureOf(status);
  };

/**
 * git's `apply_multi_file_filter` for one clean or smudge, through the
 * `filter.<d>.process` command the running command keeps open: the first
 * conversion starts the process and handshakes, every later one reuses it.
 * A failed handshake, a missing capability, a non-success status or a
 * malformed frame all fail the conversion, as in git; a process exit status
 * is reported only when the process had to be stopped.
 */
export const runFilterProcess = (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  request: FilterProcessRequest,
): Promise<FilterProcessOutcome> =>
  convertThroughPool(ctx, runner, command, {
    capability: request.capability,
    handshake,
    exchange: exchange(request),
  });
