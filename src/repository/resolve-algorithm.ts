import { objectFormatConflict } from '../domain/commands/error.js';

type Algorithm = 'sha1' | 'sha256';

/**
 * The three channels that can name a repository's object algorithm:
 * `option` (the caller's explicit `algorithm`), `declared` (the
 * repository's own `extensions.objectFormat`, read from disk), and
 * `service` (a caller-supplied `hash` override's own `algorithm`). Any
 * subset may be absent — an absent channel names nothing and cannot
 * conflict.
 */
export interface ResolveAlgorithmInput {
  readonly option?: Algorithm;
  readonly declared?: Algorithm;
  readonly service?: Algorithm;
}

/**
 * Reconcile the three algorithm channels into one resolved value: two
 * channels can each independently name the algorithm, the explicit option
 * wins when only one channel speaks, and a genuine contradiction refuses.
 * Every pair that is BOTH defined must agree; the first disagreement found
 * throws `OBJECT_FORMAT_CONFLICT`. `service` (a caller-supplied `hash`
 * override) is checked first — it is the most concrete signal — then
 * `option` against `declared`. Absent every channel, the historical default
 * `'sha1'` wins.
 */
export const resolveAlgorithm = (input: ResolveAlgorithmInput): Algorithm => {
  const { option, declared, service } = input;
  if (service !== undefined && option !== undefined && service !== option) {
    throw objectFormatConflict(service, option, 'hash');
  }
  if (service !== undefined && declared !== undefined && service !== declared) {
    throw objectFormatConflict(service, declared, 'hash');
  }
  if (option !== undefined && declared !== undefined && option !== declared) {
    throw objectFormatConflict(option, declared, 'option');
  }
  return option ?? service ?? declared ?? 'sha1';
};
