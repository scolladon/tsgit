/**
 * git's `parse_options` over `git merge`'s option table, for a command line
 * held in config (`branch.<b>.mergeoptions`): the options tsgit's merge
 * models are set, the ones that only shape output are accepted, and the
 * others refuse until tsgit runs them. Arguments that are not options, and
 * everything after `--`, are ignored as git ignores them there.
 */
import { invalidOption, unknownOption } from '../commands/error.js';
import { GIT_C_INT_MAX, GIT_C_INT_MIN, parseGitInt } from '../config/config-ini.js';
import { unsupportedOperation } from '../error.js';

/** The merge options a command line sets; an absent field was not given. */
export interface MergeCommandLine {
  readonly fastForward?: 'only' | 'never' | 'allow';
  readonly squash?: boolean;
  readonly commit?: boolean;
  readonly strategy?: ReadonlyArray<string>;
  readonly strategyOptions?: ReadonlyArray<string>;
  readonly message?: string;
  readonly log?: boolean | number;
  readonly allowUnrelatedHistories?: boolean;
  readonly autostash?: boolean;
}

type Apply = (line: MergeCommandLine, value: string | undefined, spelt: string) => MergeCommandLine;

interface MergeOption {
  readonly long?: string;
  readonly short?: string;
  readonly value: 'none' | 'required' | 'optional';
  /** Whether git also takes `--no-<long>`. */
  readonly negatable: boolean;
  readonly set: Apply;
  readonly unset: Apply;
}

interface Parsed {
  readonly line: MergeCommandLine;
  readonly next: number;
}

const END_OF_OPTIONS = '--';
const NEGATION = 'no-';
const REQUIRES_VALUE = 'requires a value';
const TAKES_NO_VALUE = 'takes no value';
const NOT_AN_INTEGER = 'expects an integer value with an optional k/m/g suffix';
/** git's `value <v> for option `<name>' not in range [<min>,<max>]`, past the option. */
const outOfRange = (value: string): string =>
  `value ${value} not in range [${GIT_C_INT_MIN},${GIT_C_INT_MAX}]`;
const PARAGRAPH_BREAK = '\n\n';

const ignore: Apply = (line) => line;

const refuse: Apply = (_line, _value, spelt) => {
  throw unsupportedOperation('merge', spelt);
};

const assign =
  <K extends keyof MergeCommandLine>(key: K, value: MergeCommandLine[K]): Apply =>
  (line) => ({ ...line, [key]: value });

const appendTo =
  (key: 'strategy' | 'strategyOptions'): Apply =>
  (line, value) => ({ ...line, [key]: [...(line[key] ?? []), value!] });

/** git's `option_parse_message`: each `-m` is a paragraph of its own. */
const appendMessage: Apply = (line, value) => ({
  ...line,
  message: line.message ? `${line.message}${PARAGRAPH_BREAK}${value!}` : value!,
});

/** `--log` alone asks for git's default count; `--log=<n>` is a C `int` with a k/m/g unit. */
const setLog: Apply = (line, value, spelt) => {
  if (value === undefined) return { ...line, log: true };
  const parsed = parseGitInt(value, BigInt(GIT_C_INT_MAX));
  if (!parsed.ok)
    throw invalidOption(
      spelt,
      parsed.reason === 'out of range' ? outOfRange(value) : NOT_AN_INTEGER,
    );
  if (parsed.value < GIT_C_INT_MIN) throw invalidOption(spelt, outOfRange(value));
  return { ...line, log: parsed.value };
};

const flag = (long: string, set: Apply, unset: Apply, short?: string): MergeOption => ({
  long,
  ...(short === undefined ? {} : { short }),
  value: 'none',
  negatable: true,
  set,
  unset,
});

const valued = (long: string, set: Apply, unset: Apply, short?: string): MergeOption => ({
  ...flag(long, set, unset, short),
  value: 'required',
});

/** `builtin/merge.c`'s `builtin_merge_options`, in its order. */
const OPTIONS: ReadonlyArray<MergeOption> = [
  { short: 'n', value: 'none', negatable: false, set: ignore, unset: ignore },
  flag('stat', ignore, ignore),
  flag('summary', ignore, ignore),
  flag('compact-summary', ignore, ignore),
  { ...flag('log', setLog, assign('log', false)), value: 'optional' },
  flag('squash', assign('squash', true), assign('squash', false)),
  flag('commit', assign('commit', true), assign('commit', false)),
  flag('edit', refuse, ignore, 'e'),
  valued('cleanup', refuse, ignore),
  flag('ff', assign('fastForward', 'allow'), assign('fastForward', 'never')),
  { ...flag('ff-only', assign('fastForward', 'only'), ignore), negatable: false },
  flag('rerere-autoupdate', refuse, ignore),
  flag('verify-signatures', refuse, ignore),
  valued('strategy', appendTo('strategy'), ignore, 's'),
  valued('strategy-option', appendTo('strategyOptions'), assign('strategyOptions', []), 'X'),
  valued('message', appendMessage, assign('message', ''), 'm'),
  { ...valued('file', refuse, ignore, 'F'), negatable: false },
  valued('into-name', refuse, ignore),
  flag('verbose', ignore, ignore, 'v'),
  flag('quiet', ignore, ignore, 'q'),
  flag('abort', refuse, ignore),
  flag('quit', refuse, ignore),
  flag('continue', refuse, ignore),
  flag(
    'allow-unrelated-histories',
    assign('allowUnrelatedHistories', true),
    assign('allowUnrelatedHistories', false),
  ),
  flag('progress', ignore, ignore),
  { ...flag('gpg-sign', refuse, ignore, 'S'), value: 'optional' },
  flag('autostash', assign('autostash', true), assign('autostash', false)),
  flag('overwrite-ignore', ignore, refuse),
  flag('signoff', refuse, ignore),
  flag('no-verify', refuse, ignore),
];

/** git's `parse_options` over `argv`, as `parse_branch_merge_options` runs it. */
export const parseMergeCommandLine = (argv: ReadonlyArray<string>): MergeCommandLine => {
  let parsed: Parsed = { line: {}, next: 0 };
  while (parsed.next < argv.length && argv[parsed.next] !== END_OF_OPTIONS) {
    parsed = parseArgument(argv, parsed);
  }
  return parsed.line;
};

const parseArgument = (argv: ReadonlyArray<string>, { line, next }: Parsed): Parsed => {
  const arg = argv[next]!;
  if (!arg.startsWith('-') || arg === '-') return { line, next: next + 1 };
  return arg.startsWith('--') ? parseLong(argv, line, next) : parseShorts(argv, line, next);
};

const parseLong = (argv: ReadonlyArray<string>, line: MergeCommandLine, at: number): Parsed => {
  const body = argv[at]!.slice(2);
  const equals = body.indexOf('=');
  const name = equals < 0 ? body : body.slice(0, equals);
  const attached = equals < 0 ? undefined : body.slice(equals + 1);
  const found = findLong(name);
  if (found === undefined) throw unknownOption(argv[at]!);
  const spelt = `--${name}`;
  const { option, negated } = found;
  if (negated || option.value === 'none') {
    if (attached !== undefined) throw invalidOption(spelt, TAKES_NO_VALUE);
    return { line: (negated ? option.unset : option.set)(line, undefined, spelt), next: at + 1 };
  }
  if (attached !== undefined || option.value === 'optional') {
    return { line: option.set(line, attached, spelt), next: at + 1 };
  }
  return takeNextValue(argv, line, at, option, spelt);
};

/** An option named outright, `--no-<name>` for a negatable one, or `<name>` undoing `no-<name>`. */
const findLong = (
  name: string,
): { readonly option: MergeOption; readonly negated: boolean } | undefined => {
  const exact = OPTIONS.find((option) => option.long === name);
  if (exact !== undefined) return { option: exact, negated: false };
  const positive = name.startsWith(NEGATION) ? negatable(name.slice(NEGATION.length)) : undefined;
  const option = positive ?? negatable(`${NEGATION}${name}`);
  return option === undefined ? undefined : { option, negated: true };
};

const negatable = (long: string): MergeOption | undefined =>
  OPTIONS.find((option) => option.long === long && option.negatable);

/** A bundle of switches (`-nqs ours`): flags apply in turn; the first valued one takes the rest. */
const parseShorts = (argv: ReadonlyArray<string>, start: MergeCommandLine, at: number): Parsed => {
  const arg = argv[at]!;
  let line = start;
  for (let index = 1; index < arg.length; index++) {
    const spelt = `-${arg[index]!}`;
    const option = OPTIONS.find((candidate) => candidate.short === arg[index]);
    if (option === undefined) throw unknownOption(spelt);
    if (option.value === 'none') {
      line = option.set(line, undefined, spelt);
      continue;
    }
    const rest = arg.slice(index + 1);
    if (rest !== '' || option.value === 'optional') {
      return { line: option.set(line, rest === '' ? undefined : rest, spelt), next: at + 1 };
    }
    return takeNextValue(argv, line, at, option, spelt);
  }
  return { line, next: at + 1 };
};

const takeNextValue = (
  argv: ReadonlyArray<string>,
  line: MergeCommandLine,
  at: number,
  option: MergeOption,
  spelt: string,
): Parsed => {
  const value = argv[at + 1];
  if (value === undefined) throw invalidOption(spelt, REQUIRES_VALUE);
  return { line: option.set(line, value, spelt), next: at + 2 };
};
