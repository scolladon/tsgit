/**
 * Pretty-format specifications for `--pretty` / `--format`. A spec is either a
 * built-in name or a `format:`/`tformat:` custom template. `parsePretty` returns
 * `undefined` for an unknown built-in name so the command boundary can raise the
 * typed `INVALID_OPTION`.
 *
 * Two framing flags drive how the (optional) diff is attached after the header:
 *   - `terminator` — emit a trailing newline in the no-diff (`-s`) case.
 *   - `blankBeforePatch` — separate the header from the diff with a blank line.
 * (`format:` is the sole spec with `terminator` false; `oneline`/`format:` are
 * the specs with `blankBeforePatch` false.)
 */

export type BuiltinName =
  | 'oneline'
  | 'short'
  | 'medium'
  | 'full'
  | 'fuller'
  | 'raw'
  | 'reference'
  | 'email'
  | 'mboxrd';

export type PrettyFormat =
  | { readonly kind: 'builtin'; readonly name: BuiltinName }
  | { readonly kind: 'custom'; readonly template: string; readonly terminator: boolean };

const BUILTINS: ReadonlySet<string> = new Set<BuiltinName>([
  'oneline',
  'short',
  'medium',
  'full',
  'fuller',
  'raw',
  'reference',
  'email',
  'mboxrd',
]);

export const parsePretty = (spec: string): PrettyFormat | undefined => {
  if (spec.startsWith('format:')) {
    return { kind: 'custom', template: spec.slice('format:'.length), terminator: false };
  }
  if (spec.startsWith('tformat:')) {
    return { kind: 'custom', template: spec.slice('tformat:'.length), terminator: true };
  }
  return BUILTINS.has(spec) ? { kind: 'builtin', name: spec as BuiltinName } : undefined;
};

export interface PrettyFraming {
  readonly terminator: boolean;
  readonly blankBeforePatch: boolean;
}

export const framingFor = (format: PrettyFormat): PrettyFraming => {
  if (format.kind === 'custom') {
    // `format:` emits no terminator and attaches the diff directly; `tformat:`
    // terminates and inserts the blank line like the built-ins.
    return { terminator: format.terminator, blankBeforePatch: format.terminator };
  }
  if (format.name === 'oneline') return { terminator: true, blankBeforePatch: false };
  // email/mboxrd carry the body (and its trailing newline) inside the header, so
  // no terminator is added and the diff attaches after a single newline.
  if (format.name === 'email' || format.name === 'mboxrd') {
    return { terminator: false, blankBeforePatch: false };
  }
  return { terminator: true, blankBeforePatch: true };
};
